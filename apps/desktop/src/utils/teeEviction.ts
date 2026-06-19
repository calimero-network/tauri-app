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

/**
 * Extract the `members` array from a merod
 * `GET /admin-api/groups/{id}/members` response. Mero-js's admin response
 * shape varies across versions — a direct `members` array on some routes,
 * a wrapped `data.members` on others — so every consumer hits the
 * dual-path lookup. Centralised here so a future shape change is one edit.
 *
 * Returns `null` (not `[]`) when the response shape is unrecognised, so
 * callers can distinguish "no members" from "couldn't tell" and fail
 * closed where appropriate. tauri-app#107 v4 review.
 */
export function extractMembersFromResponse(json: unknown): unknown[] | null {
  const raw =
    (json as { members?: unknown; data?: { members?: unknown } })?.members ??
    (json as { data?: { members?: unknown } })?.data?.members;
  return Array.isArray(raw) ? raw : null;
}

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
export interface EvictionOpts {
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
    } catch {
      // Can't see this group's children — record incompleteness, keep
      // walking the rest of the queue (other branches may still resolve).
      incomplete = true;
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
  const { groupIds, incomplete } = await enumerateGroupTree(deps, nsId);

  let evicted = 0;
  let failed = 0;
  let anyListFailed = incomplete;

  for (const groupId of groupIds) {
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
        anyListFailed = true;
        break;
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
 * Minimal shape of the live `mero` admin client this module depends on.
 * Declared locally (rather than importing the SDK type) so the eviction
 * module stays free of the heavyweight mero-js type graph and its unit
 * tests can pass a plain object.
 */
export interface MeroAdminLike {
  admin: {
    listSubgroups: (groupId: string) => Promise<{ groupId: string }[]>;
    removeGroupMembers: (
      groupId: string,
      request: { members: string[] },
    ) => Promise<void>;
  };
}

/**
 * Build `EvictionDeps` from the live runtime pieces.
 *
 * Auth: the members listing hits the local node's admin API directly via
 * `fetch` with the **local node access token** — the same canonical path
 * the list-members `useEffect` uses (NOT the cloud session token; that
 * was the Bug-1-adjacent mistake caught in tauri-app#107 review). A
 * missing/expired node token surfaces as a `listFailed` result, which
 * the reconcile retries — it no longer silently strands the TEE.
 *
 * The members fetch carries a 5s `AbortSignal.timeout` so a hung merod
 * doesn't wedge the disable / reconcile flow. Removal + subgroup
 * enumeration go through the mero admin client (which manages its own
 * auth/headers).
 *
 * `nodeToken` is read lazily via the supplied getter on every listing so
 * a token that rotates between reconcile passes is picked up fresh.
 */
export function buildEvictionDeps(args: {
  mero: MeroAdminLike;
  nodeUrl: string;
  getNodeToken: () => string | null;
  fetchImpl?: typeof fetch;
}): EvictionDeps {
  const { mero, nodeUrl, getNodeToken } = args;
  const doFetch = args.fetchImpl ?? fetch;
  // Validate the node URL once up front: it is interpolated into the
  // members fetch URL right next to the local node bearer token, so a
  // malformed / non-http(s) value (e.g. a `javascript:` or `data:` scheme
  // from a tampered settings store) must never reach `fetch`. We accept any
  // http/https origin and deliberately do NOT pin loopback — merod can be
  // configured on a remote/LAN host (the rest of the app interpolates the
  // same `settings.nodeUrl` without a loopback constraint), so pinning it
  // would break valid remote-node setups. An invalid URL fails closed
  // (listGroupMembers → null → listFailed) and the reconcile surfaces it as
  // "cleanup pending". (meroreviewer review.)
  let nodeUrlOk = false;
  try {
    const proto = new URL(nodeUrl).protocol;
    nodeUrlOk = proto === 'http:' || proto === 'https:';
  } catch {
    nodeUrlOk = false;
  }
  return {
    listGroupMembers: async (groupId) => {
      if (!nodeUrlOk) {
        // Never interpolate an unvalidated URL into a token-bearing fetch.
        console.warn(
          'buildEvictionDeps: nodeUrl is not a valid http(s) URL — cleanup pending',
        );
        return null;
      }
      const token = getNodeToken();
      if (!token) {
        // No node token → fail-closed. Reconcile retries once a token
        // is available. Never log the (absent) token.
        return null;
      }
      let resp: Response;
      try {
        resp = await doFetch(
          `${nodeUrl}/admin-api/groups/${encodeURIComponent(groupId)}/members`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
          },
        );
      } catch (e) {
        // Don't log the raw error — it can carry headers/URL with the
        // bearer token. Redacted summary only.
        console.warn(
          `buildEvictionDeps: members fetch threw for group=${short(groupId)} ` +
            `(${(e as Error)?.name ?? 'unknown'})`,
        );
        return null;
      }
      if (!resp.ok) {
        console.warn(
          `buildEvictionDeps: members http=${resp.status} for group=${short(groupId)}`,
        );
        return null;
      }
      const json = await resp.json().catch(() => null);
      return extractMembersFromResponse(json);
    },
    listSubgroups: async (groupId) => {
      const entries = await mero.admin.listSubgroups(groupId);
      return (entries ?? [])
        .map((e) => e?.groupId)
        .filter((g): g is string => typeof g === 'string' && !!g);
    },
    removeGroupMembers: async (groupId, identities) => {
      await mero.admin.removeGroupMembers(groupId, { members: identities });
    },
  };
}
