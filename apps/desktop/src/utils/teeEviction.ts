// TEE-member eviction / reconcile for the namespace HA-disable flow.
//
// Background: HA is namespace-scoped and the namespace is *client-rooted*
// — the cloud (mdma) has no namespace identity, so it cannot author
// governance ops. When HA is disabled cloud-side, the OWNER node must be
// the one to publish `MemberRemoved` for every admitted `ReadOnlyTee`
// fleet member. The root `MemberRemoved` is what drives the TEE's own
// `self_purge` (core: one root removal triggers `PurgeAction::Namespace`,
// tearing down keys + storage for the whole namespace + subgroups). The
// per-subgroup removals do NOT cascade on the OWNER's side — only the
// TEE's self-`MemberLeft` cascades — so the owner must remove the TEE
// from each subgroup explicitly to clear its OWN ledger, otherwise the
// owner still shows the fleet node in private channels (the symptom this
// module fixes).
//
// This module is intentionally dependency-injected and free of React /
// DOM globals so it can be unit-tested under the repo's `node`-env vitest
// (`src/**/*.test.ts`). `Namespaces.tsx` builds the deps from the live
// `mero` admin client + settings via `buildEvictionDeps`.
//
// See: tauri-app#106/#107, core ADR 0002, core PR #2653.

/** A hung merod must not wedge the walk; neither admin call carries a bound. */
const ADMIN_TIMEOUT_MS = 5000;

/**
 * Filter a raw member array down to the `ReadOnlyTee` identities. The
 * role is serialised by core as the bare string `"ReadOnlyTee"`
 * (GroupMemberRole, #[serde] unit variant). Anything whose `identity`
 * isn't a string or whose `role` isn't exactly `ReadOnlyTee` is dropped.
 */
export function teeIdentitiesFromMembers(raw: unknown[]): string[] {
  return raw
    .filter(
      (m: unknown): m is { identity: string; role: string } =>
        typeof (m as { identity?: unknown })?.identity === 'string' &&
        (m as { role?: unknown })?.role === 'ReadOnlyTee',
    )
    .map((m) => m.identity);
}

/**
 * Side-effecting primitives the eviction logic needs, injected so the
 * core walk is pure and unit-testable. All three are scoped to the
 * caller's local merod (node token auth); none touch the cloud.
 */
export interface EvictionDeps {
  /**
   * List a group's members. Returns the raw (un-filtered) member array,
   * or `null` when the listing could not be performed / the response
   * shape was unrecognised (fail-closed signal — caller treats it as
   * "couldn't tell", never "no TEE members").
   */
  listGroupMembers: (groupId: string) => Promise<unknown[] | null>;
  /**
   * List a group's *direct* subgroups (one level). The walk recurses to
   * cover nesting. Returns the child group ids; an empty array means a
   * leaf. Throwing is treated as "subtree unknown" (fail-closed).
   */
  listSubgroups: (groupId: string) => Promise<string[]>;
  /**
   * Remove members from a group by identity. Removing an already-removed
   * member is expected to be a harmless no-op / benign error.
   */
  removeGroupMembers: (groupId: string, identities: string[]) => Promise<void>;
}

/**
 * Cross-cutting options for an eviction run. `shouldAbort` is polled
 * before each group and before each individual remove so a superseded
 * caller (e.g. the namespace was re-enabled mid-walk) can stop issuing
 * further `MemberRemoved` ops without leaving a half-mutated tree.
 */
interface EvictionOpts {
  shouldAbort?: () => boolean;
}

export interface EvictionResult {
  /** Number of (group, identity) removals that succeeded. */
  evicted: number;
  /** Number of individual remove calls that errored. */
  failed: number;
  /**
   * `true` when we could not enumerate what was local (the root member
   * listing failed, or the subgroup walk could not be completed). The
   * caller's toast / reconcile uses this to say "cleanup pending" rather
   * than claiming success — and the reconcile will retry on next load.
   */
  listFailed: boolean;
  /** Distinct group ids visited (root + reachable subgroups). */
  groupsVisited: number;
}

/**
 * Enumerate the namespace's full group tree — root + every subgroup,
 * recursively (subgroups can nest) — deduping by group id and guarding
 * against cycles. Built on the well-defined `listSubgroups` ("direct
 * children of a group") primitive rather than assuming a flat
 * `listNamespaceGroups` includes the root or recurses.
 *
 * On any `listSubgroups` failure we record `incomplete = true` and stop
 * descending that branch but keep the groups we already found, so a
 * partial walk still evicts from what we could see while the caller
 * knows the picture was incomplete (→ retry via reconcile).
 */
export async function enumerateGroupTree(
  deps: Pick<EvictionDeps, 'listSubgroups'>,
  rootId: string,
): Promise<{ groupIds: string[]; incomplete: boolean }> {
  const seen = new Set<string>();
  const order: string[] = [];
  let incomplete = false;
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const gid = queue.shift() as string;
    if (seen.has(gid)) continue;
    seen.add(gid);
    order.push(gid);
    let children: string[];
    try {
      children = await deps.listSubgroups(gid);
    } catch (e) {
      // Can't see this group's children — record incompleteness.
      incomplete = true;
      // An abort means the whole pass is superseded; stop draining the
      // queue (every remaining `listSubgroups` would just throw too)
      // rather than spinning through the rest of the BFS (meroreviewer).
      if ((e as Error)?.name === 'AbortError') break;
      // Otherwise keep walking — other branches may still resolve.
      continue;
    }
    for (const c of children) {
      if (typeof c === 'string' && c && !seen.has(c)) queue.push(c);
    }
  }
  return { groupIds: order, incomplete };
}

/**
 * Evict every `ReadOnlyTee` member from the owner's local merod state
 * across the *entire* namespace tree (root + all subgroups). The root
 * removal drives the TEE's self-purge; the per-subgroup removals clear
 * the owner's own ledger so private channels no longer show the fleet
 * node (tauri-app#106).
 *
 * Idempotent: a group with no TEE members is a no-op; a remove that
 * targets an already-gone member is counted as failed-but-benign (core
 * returns an error for "not a member", which is the expected steady
 * state on a retry). Best-effort — never throws; surfaces counts +
 * `listFailed` for the caller's honest toast.
 *
 * Security: never logs bearer tokens or full identities. Identities are
 * truncated to an 8-char prefix (enough to correlate with admin tooling,
 * not a standalone tracking primitive). tauri-app#107 v3 review.
 */
export async function evictTeeMembersFromTree(
  deps: EvictionDeps,
  nsId: string,
  opts?: EvictionOpts,
): Promise<EvictionResult> {
  const shouldAbort = opts?.shouldAbort;
  // Bail before any enumeration if the caller is already superseded, so a
  // pass that lost its race never even walks the tree (meroreviewer).
  if (shouldAbort?.()) {
    return { evicted: 0, failed: 0, listFailed: true, groupsVisited: 0 };
  }
  const { groupIds, incomplete } = await enumerateGroupTree(deps, nsId);

  let evicted = 0;
  let failed = 0;
  let anyListFailed = incomplete;

  walk: for (const groupId of groupIds) {
    // Bail out of the (mutating) walk if the caller has been superseded —
    // e.g. the namespace's HA state changed (re-enabled) while we were
    // mid-walk. Without this, an in-flight reconcile would keep issuing
    // `MemberRemoved` for a namespace that is no longer HA-disabled,
    // evicting a TEE that was just re-admitted (cursor). `listFailed`
    // marks the partial result incomplete; the caller discards it anyway
    // once superseded.
    if (shouldAbort?.()) {
      anyListFailed = true;
      break;
    }
    let raw: unknown[] | null;
    try {
      raw = await deps.listGroupMembers(groupId);
    } catch (e) {
      anyListFailed = true;
      console.warn(
        `evictTeeMembersFromTree: list-members threw for group=${short(groupId)} ` +
          `(${(e as Error)?.name ?? 'unknown'}) — cleanup pending`,
      );
      continue;
    }
    if (raw === null) {
      // For the namespace ROOT a null listing is fail-closed (we can't
      // tell whether a TEE is present, and the root removal is what
      // drives the TEE self-purge). For subgroups it likewise means
      // "couldn't tell" → mark incomplete so the reconcile retries.
      anyListFailed = true;
      console.warn(
        `evictTeeMembersFromTree: list-members body unrecognised for group=${short(
          groupId,
        )} — cleanup pending`,
      );
      continue;
    }
    const teeIds = teeIdentitiesFromMembers(raw);
    if (teeIds.length === 0) continue;

    for (const identity of teeIds) {
      if (shouldAbort?.()) {
        // Abort the whole walk, not just this group's remaining identities.
        anyListFailed = true;
        break walk;
      }
      try {
        await deps.removeGroupMembers(groupId, [identity]);
        evicted += 1;
      } catch (e) {
        console.warn(
          `evictTeeMembersFromTree: remove failed for group=${short(
            groupId,
          )} identity=${short(identity)} (${(e as Error)?.name ?? 'unknown'})`,
        );
        failed += 1;
      }
    }
  }

  return {
    evicted,
    failed,
    listFailed: anyListFailed,
    groupsVisited: groupIds.length,
  };
}

/**
 * Reconcile: for every namespace that is HA-DISABLED in cloud state but
 * still has at least one local `ReadOnlyTee` member somewhere in its
 * tree, run the eviction. This is the self-healing path — a transient
 * failure in the fast post-toggle eviction (expired node token, hung
 * merod, gossip not yet propagated) no longer strands the TEE forever:
 * the next namespace load / HA-status refresh retries.
 *
 * `haEnabled` is the cloud-derived map: `false` means "cloud says HA is
 * off for this namespace". We only act on explicit `false` (not
 * `undefined`, which means "unknown / not in cloud") to avoid evicting a
 * TEE whose namespace HA state we haven't confirmed is disabled.
 *
 * Returns per-namespace results for the namespaces we actually touched
 * (had local TEE members). Namespaces with no local TEE members are
 * skipped silently — the steady state once eviction has succeeded.
 */
export async function reconcileDisabledNamespaces(
  deps: EvictionDeps,
  haEnabled: Record<string, boolean>,
  opts?: EvictionOpts,
): Promise<Record<string, EvictionResult>> {
  const results: Record<string, EvictionResult> = {};
  const disabled = Object.keys(haEnabled).filter((nsId) => haEnabled[nsId] === false);
  if (opts?.shouldAbort?.()) return results;
  // Each namespace is an independent tree, so evict them concurrently —
  // for a user with many HA-disabled namespaces this avoids serialising the
  // walks. `evictTeeMembersFromTree` is best-effort and never throws, but we
  // still use `allSettled` so one namespace's failure can never abort the
  // others. (No root short-circuit: a subgroup can hold a stranded TEE even
  // when the root is clean — Bug 2 — and the walk already skips groups with
  // no TEE members.)
  const settled = await Promise.allSettled(
    disabled.map(async (nsId): Promise<[string, EvictionResult]> => [
      nsId,
      await evictTeeMembersFromTree(deps, nsId, opts),
    ]),
  );
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    const [nsId, result] = outcome.value;
    if (result.evicted > 0 || result.failed > 0 || result.listFailed) {
      results[nsId] = result;
    }
  }
  return results;
}

/** Truncate an opaque id (group id / identity public key) for logging. */
function short(id: string): string {
  return `${id.slice(0, 8)}…`;
}

/**
 * Race a promise against a deadline (and an optional abort signal). Racing the
 * signal in as well means an abort mid-call is honoured immediately rather than
 * only at the next `shouldAbort` poll.
 */
function withDeadline<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => settle(() => reject(new DOMException('Aborted', 'AbortError')));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    timer = setTimeout(
      () => settle(() => reject(new DOMException('Timed out', 'TimeoutError'))),
      ms,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => settle(() => resolve(v)),
      (e) => settle(() => reject(e)),
    );
  });
}

/**
 * Minimal shape of the live `mero` admin client this module depends on.
 * Declared locally (rather than importing the SDK type) so the eviction
 * module stays free of the heavyweight mero-js type graph and its unit
 * tests can pass a plain object.
 */
export interface MeroAdminLike {
  admin: {
    listGroupMembers: (groupId: string) => Promise<{ members: unknown[] }>;
    listSubgroups: (groupId: string) => Promise<{ groupId: string }[]>;
    removeGroupMembers: (
      groupId: string,
      request: { members: string[] },
    ) => Promise<void>;
  };
}

/**
 * Build `EvictionDeps` from the live `mero` admin client, so every call here
 * shares the app's one token store and its refresh rather than reading an
 * access token that may already have expired.
 *
 * The caller's `signal` (the reconcile pass's AbortController) is raced into
 * both listings, so a superseded pass cancels immediately rather than waiting
 * out the deadline. A failure surfaces as `listFailed` and the reconcile on the
 * next load retries it.
 */
export function buildEvictionDeps(args: {
  mero: MeroAdminLike;
  signal?: AbortSignal;
}): EvictionDeps {
  const { mero, signal } = args;
  return {
    listGroupMembers: async (groupId) => {
      // Caller already superseded (e.g. HA re-enabled) - don't start a call
      // whose answer we would only discard.
      if (signal?.aborted) return null;
      try {
        const response = await withDeadline(
          mero.admin.listGroupMembers(groupId),
          ADMIN_TIMEOUT_MS,
          signal,
        );
        return response.members;
      } catch (e) {
        console.warn(
          `buildEvictionDeps: list-members failed for group=${short(groupId)} ` +
            `(${(e as Error)?.name ?? 'unknown'}) - cleanup pending`,
        );
        return null;
      }
    },
    listSubgroups: async (groupId) => {
      // Throwing makes `enumerateGroupTree` mark the walk incomplete and stop
      // descending, so a cancelled pass issues no further admin calls.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const entries = await withDeadline(
        mero.admin.listSubgroups(groupId),
        ADMIN_TIMEOUT_MS,
        signal,
      );
      return (entries ?? [])
        .map((e) => e?.groupId)
        .filter((g): g is string => typeof g === 'string' && !!g);
    },
    removeGroupMembers: async (groupId, identities) => {
      await mero.admin.removeGroupMembers(groupId, { members: identities });
    },
  };
}
