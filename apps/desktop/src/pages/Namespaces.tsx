import { useState, useEffect, useCallback, useRef } from "react";
import {
  useMero,
  useNamespaces,
  useNamespaceGroups,
  useGroupInfo,
  useGroupMembers,
  useGroupContexts,
  useSubgroups,
  useCreateNamespace,
  type Namespace,
} from "@calimero-network/mero-react";
import type { GroupInfo, MetadataRecord } from "@calimero-network/mero-js";
import { useToast } from "../contexts/ToastContext";
import { ChevronLeft, Users, Box, Layers, Copy, ChevronRight, Shield, Globe, Plus, X, Trash2, UserMinus, Link, ChevronDown, Check, MoreHorizontal, LogIn } from "lucide-react";
import { apiClient } from "../lib/mero-client";
import { saveContextKey } from "../utils/contextKeys";
import { decodeMetadata } from "../utils/appUtils";
import { getSettings } from "../utils/settings";
import {
  enableHaForNamespace,
  disableHaNamespace,
  getCloudNamespaces,
  CloudSessionExpiredError,
} from "../utils/cloudApi";
import { getCloudIdToken } from "../utils/cloudAuth";
import { getAccessToken } from "../lib/token-storage";
import { parseJwtPayload } from "../utils/jwt";
import {
  buildEvictionDeps,
  evictTeeMembersFromTree,
  extractMembersFromResponse,
  reconcileDisabledNamespaces,
  type EvictionResult,
} from "../utils/teeEviction";
import { useCloudEnabled } from "../hooks/useCloudEnabled";
import "./Namespaces.css";

function parseApiError(e: any): string {
  if (!e) return 'Unknown error';
  const status = e?.status ? `${e.status}: ` : '';

  // SDK HTTPError — bodyText is the raw response body
  if (typeof e?.bodyText === 'string' && e.bodyText) {
    try {
      const p = JSON.parse(e.bodyText);
      const human = p?.error ?? p?.message ?? p?.msg ?? p?.detail ?? p?.details ?? p?.reason;
      if (human) return `${status}${String(human)}`;
      // Whole body is JSON but no known field — compact it, cap at 200 chars
      const compact = JSON.stringify(p);
      return `${status}${compact.length > 200 ? compact.slice(0, 200) + '…' : compact}`;
    } catch {
      const t = e.bodyText.trim();
      return `${status}${t.length > 200 ? t.slice(0, 200) + '…' : t}`;
    }
  }

  // Plain JS Error whose message happens to be JSON
  const msg: string = e?.message ?? String(e);
  try {
    const p = JSON.parse(msg);
    const human = p?.error ?? p?.message ?? p?.msg;
    if (human) return `${status}${String(human)}`;
  } catch {}

  if (e?.body?.error) return `${status}${String(e.body.error)}`;
  return `${status}${msg}`;
}

const DEFAULT_NAMESPACE_CAPABILITIES = 1 | 2 | 8;

interface InstalledApp {
  id: string;
  name: string;
  frontendUrl: string | null;
  metadata?: unknown;
}

function readInstalledApps(): Promise<InstalledApp[]> {
  return apiClient.node.listApplications().then((res) => {
    if (res.error || !Array.isArray(res.data)) return [];
    return res.data.map((app: any) => {
      let name: string = app.id;
      let frontendUrl: string | null = null;
      try {
        const meta = decodeMetadata(app.metadata);
        if (meta) {
          name = meta.name || meta.alias || app.id;
          frontendUrl = meta?.links?.frontend ?? null;
        }
      } catch {
        // ignore
      }
      return { id: app.id, name, frontendUrl };
    });
  });
}

type View =
  | { type: "list" }
  | { type: "namespace"; ns: Namespace }
  | { type: "group"; ns: Namespace; groupId: string };

// The merod admin group-info response (core's GroupInfoApiResponseData,
// crates/server/primitives/src/admin/mod.rs, #[serde(rename_all =
// "camelCase")]) carries `groupStateHash` — a governance-convergence hash —
// that the bundled mero-js `GroupInfo` type still omits. `subgroupVisibility`
// and `metadata` are already present on the SDK type (and we keep the SDK's
// `MetadataRecord` shape verbatim via Omit, so the cast at the use sites is a
// sound widening of the stale SDK type rather than a redeclaration).
//
// We re-add `metadata` through Omit (instead of `extends`) because declaring
// it again on a subtype clashes with the SDK's `metadata?: MetadataRecord |
// null` (TS2430) — Omit-then-restore keeps the field wire-accurate without the
// conflict. Drop the whole alias once mero-js exposes `groupStateHash`.
type GroupInfoExt = Omit<GroupInfo, "metadata"> & {
  metadata?: MetadataRecord | null;
  groupStateHash?: string;
};

export default function Namespaces() {
  const toast = useToast();
  const { mero } = useMero();
  const cloudEnabled = useCloudEnabled();
  const [view, setView] = useState<View>({ type: "list" });

  const activeNsId = view.type === "namespace" || view.type === "group" ? view.ns.namespaceId : null;
  const activeGroupId = view.type === "group" ? view.groupId : null;
  const activeNsRootId = (view.type === "namespace" || view.type === "group") ? view.ns.namespaceId : null;

  const { namespaces, loading, error, refetch: refetchNamespaces } = useNamespaces();
  const { groups: nsGroups, loading: nsLoadingGroups, error: nsGroupsError, refetch: refetchNsGroups } = useNamespaceGroups(activeNsId) as any;
  const { groupInfo: groupInfoRaw, loading: groupInfoLoading } = useGroupInfo(activeGroupId);
  const { groupInfo: nsRootGroupInfoRaw } = useGroupInfo(activeNsRootId);
  // The SDK's `GroupInfo` is stale vs core's API (skew): it lacks
  // `groupStateHash` that the live merod response carries. We narrow to the
  // wire-accurate `GroupInfoExt` (a sound widening — see its definition).
  // Remove this cast once mero-js is bumped to expose the field.
  const groupInfo = groupInfoRaw as GroupInfoExt | null;
  const nsRootGroupInfo = nsRootGroupInfoRaw as GroupInfoExt | null;
  const { members: groupMembers, refetch: refetchGroupMembers } = useGroupMembers(activeGroupId) as any;
  const [nsMembers, setNsMembers] = useState<any[]>([]);
  const [nsMembersLoading, setNsMembersLoading] = useState(false);
  const [nsMembersVersion, setNsMembersVersion] = useState(0);

  useEffect(() => {
    if (view.type !== "namespace" || !activeNsRootId) { setNsMembers([]); return; }
    const controller = new AbortController();
    const settings = getSettings();
    const token = getAccessToken();
    if (!settings.nodeUrl || !token) { setNsMembers([]); return; }
    setNsMembersLoading(true);
    // TODO: replace with mero.admin.listGroupMembers once mero-react hook parsing is fixed
    fetch(`${settings.nodeUrl}/admin-api/groups/${encodeURIComponent(activeNsRootId)}/members`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((json) => {
        setNsMembers(extractMembersFromResponse(json) ?? []);
      })
      .catch((e) => { if (e?.name !== 'AbortError') setNsMembers([]); })
      .finally(() => setNsMembersLoading(false));
    return () => controller.abort();
  }, [activeNsRootId, nsMembersVersion, view.type]);

  const { contexts: groupContexts, refetch: refetchGroupContexts } = useGroupContexts(activeGroupId);
  const { contexts: nsRootContexts, refetch: refetchNsRootContexts } = useGroupContexts(
    view.type === "namespace" ? view.ns.namespaceId : null,
  );
  const { subgroups: groupSubgroups = [], refetch: refetchSubgroups } = useSubgroups(activeGroupId) as any;

  const { createNamespace, loading: creatingNamespace } = useCreateNamespace();
  const [creatingContext, setCreatingContext] = useState(false);

  // Action state
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteNsTarget, setDeleteNsTarget] = useState<Namespace | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<string | null>(null);
  const [deleteContextTarget, setDeleteContextTarget] = useState<{ contextId: string; name: string; refetch: () => void } | null>(null);
  const [removeMemberTarget, setRemoveMemberTarget] = useState<{ groupId: string; identity: string; name: string; onSuccess: () => void } | null>(null);
  const [inviteModal, setInviteModal] = useState<{ groupId: string; isNamespace: boolean } | null>(null);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const [joinNsModal, setJoinNsModal] = useState(false);
  const [joinCtxModal, setJoinCtxModal] = useState<{ groupId: string; refetch: () => void } | null>(null);

  const [myIdentity, setMyIdentity] = useState<string | null>(null);
  useEffect(() => {
    const payload = parseJwtPayload(getAccessToken());
    const id = payload?.sub || payload?.identity || payload?.public_key;
    if (id && typeof id === 'string') setMyIdentity(id);
  }, []);

  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  useEffect(() => {
    readInstalledApps().then(setInstalledApps).catch(() => setInstalledApps([]));
  }, []);

  const appById = installedApps.reduce<Record<string, InstalledApp>>((acc, a) => {
    acc[a.id] = a;
    return acc;
  }, {});

  const nsDisplayName = (ns: Namespace) => {
    const fromList = (ns as any).name as string | undefined;
    const fromGroupMeta = nsRootGroupInfo && ns.namespaceId === activeNsRootId
      ? nsRootGroupInfo.metadata?.name as string | undefined
      : undefined;
    const fromApp = appById[ns.targetApplicationId]?.name;
    return fromList || fromGroupMeta || fromApp || truncateId(ns.namespaceId);
  };

  const [nsModalOpen, setNsModalOpen] = useState(false);
  const [ctxModalOpen, setCtxModalOpen] = useState<{ namespaceId: string; applicationId: string } | null>(null);
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);

  const groupLoading = groupInfoLoading;

  useEffect(() => {
    if (!actionsMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [actionsMenuOpen]);

  // ── Handlers ──

  const onCreateNamespace = async (applicationId: string, alias: string | undefined) => {
    if (!mero) { toast.error("Node client not ready"); return; }
    try {
      const result = await createNamespace({
        applicationId,
        upgradePolicy: "Automatic",
        name: alias?.trim() || undefined,
      } as any);
      if (!result) throw new Error("createNamespace returned null");
      try {
        await mero.admin.setDefaultCapabilities(result.namespaceId, {
          defaultCapabilities: DEFAULT_NAMESPACE_CAPABILITIES,
        });
      } catch (capErr) {
        console.warn("setDefaultCapabilities failed:", capErr);
      }
      toast.success(`Namespace created: ${truncateId(result.namespaceId)}`);
      setNsModalOpen(false);
      await refetchNamespaces();
    } catch (e: any) {
      toast.error(`Failed to create namespace: ${e?.message ?? String(e)}`);
    }
  };

  const onCreateContext = async (
    namespaceId: string,
    applicationId: string,
    serviceName: string,
    alias: string | undefined,
    initArgs: string,
  ) => {
    if (!mero) return;
    setCreatingContext(true);
    try {
      const argsJson = initArgs.trim() || '{}';
      const result = await (mero.admin as any).createContext({
        applicationId,
        groupId: namespaceId,
        serviceName: serviceName.trim() || undefined,
        initializationParams: Array.from(new TextEncoder().encode(argsJson)),
        name: alias?.trim() || undefined,
      });
      if (!result) throw new Error('createContext returned null');
      saveContextKey(result.contextId, result.memberPublicKey, applicationId);
      toast.success(`Context created: ${truncateId(result.contextId)}`);
      setCtxModalOpen(null);
      await Promise.all([refetchGroupContexts?.(), refetchNsRootContexts?.()]);
    } catch (e: any) {
      toast.error(`Failed to create context: ${parseApiError(e)}`);
    } finally {
      setCreatingContext(false);
    }
  };

  const handleDeleteNamespace = async (ns: Namespace) => {
    if (!mero) return;
    setActionLoading(true);
    try {
      await (mero.admin as any).deleteNamespace(ns.namespaceId, {});
      toast.success('Namespace deleted');
      setDeleteNsTarget(null);
      setView({ type: 'list' });
      await refetchNamespaces();
    } catch (e: any) {
      toast.error(`Failed to delete namespace: ${parseApiError(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!mero) return;
    setActionLoading(true);
    try {
      await (mero.admin as any).deleteGroup(groupId, {});
      toast.success('Group deleted');
      setDeleteGroupTarget(null);
      if (view.type === 'group') setView({ type: 'namespace', ns: view.ns });
      await Promise.all([
        refetchNsGroups?.(),
        refetchSubgroups?.(),
      ]);
    } catch (e: any) {
      toast.error(`Failed to delete group: ${parseApiError(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteContext = async (contextId: string, refetch: () => void) => {
    if (!mero) return;
    setActionLoading(true);
    try {
      await mero.admin.deleteContext(contextId);
      toast.success('Context deleted');
      setDeleteContextTarget(null);
      await Promise.all([
        refetch(),
        refetchNsRootContexts?.(),
        refetchGroupContexts?.(),
      ]);
    } catch (e: any) {
      toast.error(`Failed to delete context: ${parseApiError(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveMember = async (groupId: string, identity: string, onSuccess: () => void) => {
    if (!mero) return;
    setActionLoading(true);
    try {
      await mero.admin.removeGroupMembers(groupId, { members: [identity] });
      toast.success('Member removed');
      setRemoveMemberTarget(null);
      onSuccess();
      refetchGroupMembers?.();
    } catch (e: any) {
      toast.error(`Failed to remove member: ${parseApiError(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * Evict every `ReadOnlyTee` member from the owner's local merod state
   * across the namespace's *entire* group tree — root + all subgroups,
   * recursively. Called after a successful cloud `disable-ha` so the
   * owner publishes `MemberRemoved` over gossip for each.
   *
   * Two distinct effects, both required (tauri-app#106):
   *   • The ROOT removal drives the TEE's own `self_purge` (core: one
   *     root removal triggers `PurgeAction::Namespace`, tearing down keys
   *     + storage for the whole namespace + subgroups) and fires the
   *     key-rotation pipeline (forward secrecy on new writes).
   *   • The PER-SUBGROUP removals clear the OWNER's own ledger. A root
   *     `MemberRemoved` does NOT cascade to subgroups on the owner's side
   *     (only the TEE's self-`MemberLeft` cascades), so without these the
   *     owner still shows the fleet node in private channels — the exact
   *     symptom this fixes (Bug 2).
   *
   * Auth: the per-group members listing uses the **local node access
   * token** (`getAccessToken()`), NOT the cloud session token — the same
   * canonical path the list-members `useEffect` uses (tauri-app#107
   * review). A missing/expired node token, a hung merod (5s timeout), or
   * an unreadable subgroup surfaces as `listFailed: true`; the reconcile
   * on the next namespace/HA-status load retries automatically, so a
   * single transient failure no longer strands the TEE forever (Bug 1).
   *
   * Best-effort: never throws. The tree walk + idempotent removals live
   * in `utils/teeEviction.ts` (pure, unit-tested). Returns counts +
   * `listFailed` for the caller's honest toast tiers.
   *
   * See: tauri-app#106/#107, core ADR 0002, core PR #2653.
   */
  const evictTeeMembersAfterDisable = async (
    nsId: string,
  ): Promise<EvictionResult> => {
    // Fail closed on every pre-flight that means "we couldn't check what
    // was local" (mero client not ready, nodeUrl unconfigured). The toast
    // then honestly says cleanup is pending instead of claiming success;
    // the reconcile retries. A missing node token is handled inside the
    // deps (→ listFailed), not here, so the reconcile path shares it.
    // tauri-app#107 v3 review (cursor + meroreviewer).
    if (!mero) return { evicted: 0, failed: 0, listFailed: true, groupsVisited: 0 };
    const settings = getSettings();
    if (!settings.nodeUrl) return { evicted: 0, failed: 0, listFailed: true, groupsVisited: 0 };

    const deps = buildEvictionDeps({
      mero,
      nodeUrl: settings.nodeUrl,
      getNodeToken: getAccessToken,
    });
    return evictTeeMembersFromTree(deps, nsId);
  };

  const handleJoinNamespace = async (invitationText: string) => {
    if (!mero) return;
    setActionLoading(true);
    try {
      const decoded = JSON.parse(atob(invitationText.trim()));
      const namespaceId = (decoded.invitation.invitation.group_id as number[])
        .map((b: number) => b.toString(16).padStart(2, '0')).join('');
      await mero.admin.joinNamespace(namespaceId, decoded);
      toast.success('Joined namespace');
      setJoinNsModal(false);
      await refetchNamespaces();
    } catch (e: any) {
      toast.error(`Failed to join namespace: ${parseApiError(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleJoinContext = async (invitationText: string, refetch: () => void) => {
    if (!mero) return;
    setActionLoading(true);
    try {
      const decoded = JSON.parse(atob(invitationText.trim()));
      await mero.admin.joinGroup(decoded);
      toast.success('Joined context');
      setJoinCtxModal(null);
      refetch();
    } catch (e: any) {
      toast.error(`Failed to join context: ${parseApiError(e)}`);
    } finally {
      setActionLoading(false);
    }
  };

  // ── HA state — keyed by namespaceId. `haEnabling` is a per-namespace map so toggling one namespace doesn't lock every other toggle. ──
  const [haEnabling, setHaEnabling] = useState<Record<string, boolean>>({});
  const [haEnabled, setHaEnabled] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const token = getCloudIdToken();
    if (!token) return;
    let cancelled = false;
    getCloudNamespaces(token)
      .then((namespaces) => {
        if (cancelled) return;
        const byNamespace: Record<string, boolean> = {};
        for (const n of namespaces) {
          if (!n.namespace_id) continue;
          if (n.ha_status === "enabled") byNamespace[n.namespace_id] = true;
          else if (byNamespace[n.namespace_id] === undefined) byNamespace[n.namespace_id] = false;
        }
        setHaEnabled(byNamespace);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ── Reconcile: self-heal stranded TEE members ──
  // The post-toggle eviction (in `toggleHa`) is the fast path, but it can
  // bail transiently (expired node token, hung merod, gossip not yet
  // propagated) and — because `haEnabled` has already flipped to false —
  // the disable branch can no longer be re-clicked. Without a retry the
  // TEE is stranded in the owner's ledger forever (Bug 1).
  //
  // This reconcile runs whenever the cloud-derived `haEnabled` map changes
  // (namespace load / HA-status refresh) and re-evicts any `ReadOnlyTee`
  // member that is still present locally for a namespace the cloud reports
  // as HA-DISABLED. It walks the whole tree (root + subgroups), so it also
  // mops up subgroup rows the root-only v1 left behind (Bug 2). Idempotent
  // and skips namespaces with no local TEE members, so the steady state is
  // a cheap no-op.
  // Eviction concurrency guard. This is a *counting* semaphore, NOT a
  // boolean: both the reconcile effect and the `toggleHa` disable fast-path
  // are eviction "owners", and a boolean let an in-flight reconcile's
  // `finally` clear a flag that `toggleHa` had set — re-opening the gate
  // mid-disable and allowing a concurrent tree walk (cursor). A counter
  // only re-opens once every owner has released. A new reconcile pass
  // starts only when the count is 0.
  const reconcileBusyRef = useRef(0);
  // A trigger arriving while an eviction is in flight must NOT be dropped:
  // the in-flight pass may be working off now-stale `haEnabled`, and if this
  // is the last trigger the namespace would be stranded forever. Record it
  // and re-run once the count drains to 0 (cursor + meroreviewer).
  const reconcilePendingRef = useRef(false);
  // Bounded self-heal: when a completed pass left work undone (couldn't
  // enumerate local state → `listFailed`, OR a `removeGroupMembers` call
  // kept failing → `failed > 0`) and no other trigger is coming, retry on a
  // timer up to a cap so the "retries automatically" promise actually holds
  // — without polling forever (cursor + meroreviewer). The budget resets on
  // every genuine `haEnabled` change, so each new disable round gets a fresh
  // set of retries and a persistently-failing namespace can't starve a
  // newly-disabled one.
  const reconcileRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcileRetryCount = useRef(0);
  const reconcileExhaustedRef = useRef(false);
  // The `haEnabled` reference the retry budget was last reset for. Reset on a
  // genuine reference change (new disable / cloud refresh) but NOT on retry-
  // driven re-runs (same reference, only `reconcileTick` bumps). Doing this
  // inside the effect — instead of a separate `[haEnabled]` effect — keeps
  // the reset from racing the in-flight pass's retry bookkeeping (mero).
  const reconcileBudgetKeyRef = useRef(haEnabled);
  const RECONCILE_MAX_RETRIES = 5;
  const RECONCILE_RETRY_MS = 30_000;
  const [reconcileTick, setReconcileTick] = useState(0);
  const triggerReconcile = useCallback(() => setReconcileTick((t) => t + 1), []);
  const clearReconcileRetryTimer = useCallback(() => {
    if (reconcileRetryTimer.current !== null) {
      clearTimeout(reconcileRetryTimer.current);
      reconcileRetryTimer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!mero) return;
    const settings = getSettings();
    if (!settings.nodeUrl) return;
    // Fresh retry budget on a genuine `haEnabled` change; retry-driven
    // re-runs (same reference, new tick) keep the current budget. The prior
    // pass is already `cancelled` by the time we get here, so this can't
    // race its bookkeeping (mero).
    if (reconcileBudgetKeyRef.current !== haEnabled) {
      reconcileBudgetKeyRef.current = haEnabled;
      reconcileRetryCount.current = 0;
      reconcileExhaustedRef.current = false;
    }
    // Only act when the cloud has actually told us at least one namespace
    // is disabled. `=== false` (not `undefined`) gates this — `undefined`
    // means "unknown / not in cloud", and we must not evict a TEE whose
    // HA state we haven't confirmed is off.
    const hasDisabled = Object.values(haEnabled).some((v) => v === false);
    if (!hasDisabled) return;
    if (reconcileBusyRef.current > 0) {
      // Defer instead of dropping — re-run after the count drains to 0.
      reconcilePendingRef.current = true;
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    reconcileBusyRef.current += 1;
    reconcilePendingRef.current = false;
    const deps = buildEvictionDeps({
      mero,
      nodeUrl: settings.nodeUrl,
      getNodeToken: getAccessToken,
    });
    reconcileDisabledNamespaces(deps, haEnabled, {
      shouldAbort: () => controller.signal.aborted,
    })
      .then((results) => {
        if (cancelled) return;
        const touched = Object.values(results);
        // Schedule the retry / clear the budget BEFORE the UI mirroring
        // below, so a throw from a `toast`/refetch call can never drop a
        // needed retry (mero). "Done" = every disabled namespace fully
        // enumerated with no failed removes; anything short of that
        // (listFailed OR `failed > 0`) schedules a bounded retry (cursor).
        const needsRetry = touched.some((r) => r.listFailed || r.failed > 0);
        if (!needsRetry) {
          reconcileRetryCount.current = 0;
          reconcileExhaustedRef.current = false;
          clearReconcileRetryTimer();
        } else if (reconcileRetryTimer.current === null) {
          if (reconcileRetryCount.current < RECONCILE_MAX_RETRIES) {
            reconcileRetryCount.current += 1;
            reconcileRetryTimer.current = setTimeout(() => {
              reconcileRetryTimer.current = null;
              triggerReconcile();
            }, RECONCILE_RETRY_MS);
          } else if (!reconcileExhaustedRef.current) {
            // Out of automatic retries — surface it once so the user isn't
            // left believing cleanup is still in progress (meroreviewer).
            reconcileExhaustedRef.current = true;
            toast.error(
              'Automatic TEE cleanup did not finish after several retries. ' +
                'Toggle HA off again, or restart the app, to retry.',
            );
          }
        }
        const evicted = touched.reduce((n, r) => n + r.evicted, 0);
        if (evicted > 0) {
          // We changed local membership — mirror it into the UI.
          setNsMembersVersion((v) => v + 1);
          refetchGroupMembers?.();
          toast.success(
            `Cleaned up ${evicted} stranded TEE member(s) from HA-disabled namespace(s)`,
          );
        }
      })
      .catch((e) => {
        // `reconcileDisabledNamespaces` is best-effort and should not
        // reject; a rejection here signals a programming error, so log it
        // (no user-facing toast) rather than swallowing it silently (mero).
        console.warn(
          `reconcile: unexpected rejection (${(e as Error)?.name ?? 'unknown'})`,
        );
      })
      .finally(() => {
        reconcileBusyRef.current = Math.max(0, reconcileBusyRef.current - 1);
        // All owners released and a trigger arrived mid-pass — re-run
        // against the latest state.
        if (reconcileBusyRef.current === 0 && reconcilePendingRef.current) {
          reconcilePendingRef.current = false;
          triggerReconcile();
        }
      });
    return () => {
      cancelled = true;
      // Stop the in-flight mutating walk for this now-superseded snapshot
      // (e.g. HA was re-enabled mid-walk) and drop any pending retry timer;
      // the re-run reschedules a retry if one is still needed (cursor + mero).
      controller.abort();
      clearReconcileRetryTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [haEnabled, mero, reconcileTick]);

  // Clear any pending reconcile retry timer on unmount.
  useEffect(() => clearReconcileRetryTimer, [clearReconcileRetryTimer]);

  const toggleHa = useCallback(async (ns: Namespace) => {
    const token = getCloudIdToken();
    if (!token) { toast.error('Connect to Calimero Cloud first (Settings → Cloud)'); return; }
    const settings = getSettings();
    if (!settings.nodeUrl) { toast.error('Node URL not configured'); return; }
    if (!mero) { toast.error('Local node client is not ready yet'); return; }

    const nsId = ns.namespaceId;
    const isEnabled = !!haEnabled[nsId];
    setHaEnabling((prev) => ({ ...prev, [nsId]: true }));

    try {
      if (isEnabled) {
        await disableHaNamespace(token, nsId);
        // Acquire the eviction semaphore BEFORE flipping `haEnabled` to
        // false. That state change triggers the reconcile effect; without
        // the claim it would walk the same namespace tree concurrently with
        // our own eviction below, double-issuing removes and duplicating the
        // success toast (cursor). Because it's a counter (not a boolean), an
        // unrelated in-flight reconcile releasing its own hold can't re-open
        // the gate while we still hold it. The effect defers (pending-rerun)
        // until the count drains; the inner `finally` releases our hold and
        // triggers a single reconcile pass to mop up leftovers / retry.
        reconcileBusyRef.current += 1;
        setHaEnabled((prev) => ({ ...prev, [nsId]: false }));
        try {
          // Cloud-side disable is done; now evict any admitted TEE members
          // from this owner's local merod. Without this, `MemberRemoved` is
          // never published, no key rotation fires, and the fleet node
          // remains a `ReadOnlyTee` member of our local group state
          // indefinitely (see tauri-app#106 + core ADR 0002).
          const evictResult = await evictTeeMembersAfterDisable(nsId);
          // Refresh the Members list if any remove call ran (success OR
          // failure). On `failed > 0` the store state could still have
          // changed in mero before the failure, and refetching reflects
          // truth. On pure `listFailed` we have no removals to mirror, so
          // skip the refresh. Mirrors the `handleRemoveMember` pattern.
          // tauri-app#107 v3 review (cursor) + v5 review (defensive
          // `failed > 0` arm per meroreviewer).
          if (evictResult.evicted > 0 || evictResult.failed > 0) {
            setNsMembersVersion((v) => v + 1);
            refetchGroupMembers?.();
          }
          // Toast tiers — honest about what happened. Unlike v1, a transient
          // failure here is NOT a dead end: the reconcile (which runs on
          // namespace/HA-status load) retries automatically, so the copy now
          // says "will retry" rather than "restart to retry" (tauri-app#106).
          //   * everything succeeded → standard success
          //   * list-members fetch / subgroup walk failed → cloud is
          //     disabled but we couldn't fully enumerate what's local; the
          //     reconcile retries on next load
          //   * partial per-member failure → reconcile retries the leftovers
          //   * zero TEE members found locally → nothing to evict (fleet
          //     never admitted before disable, or gossip hadn't propagated)
          if (evictResult.listFailed) {
            toast.success(
              'HA disabled cloud-side. Local membership cleanup is incomplete — ' +
                'it will retry automatically on the next refresh.',
            );
          } else if (evictResult.failed > 0) {
            toast.success(
              `HA disabled — ${evictResult.evicted} TEE member(s) evicted, ` +
                `${evictResult.failed} cleanup failed; will retry automatically.`,
            );
          } else if (evictResult.evicted > 0) {
            toast.success(
              `HA disabled — ${evictResult.evicted} TEE member(s) evicted; ` +
                'forward secrecy applied via key rotation',
            );
          } else {
            toast.success('HA disabled — TEE nodes will stop replicating');
          }
        } finally {
          // Release our hold and let the reconcile run once against the
          // latest state (idempotent no-op if we already cleaned up; a
          // genuine retry if our fast-path eviction left work undone). If
          // another eviction is still in flight, the count stays > 0 and the
          // pending-rerun mechanism re-triggers once it drains.
          reconcileBusyRef.current = Math.max(0, reconcileBusyRef.current - 1);
          if (reconcileBusyRef.current === 0) {
            triggerReconcile();
          } else {
            // Another eviction is still in flight — let it re-trigger once
            // the count drains, rather than racing a pass against it now.
            reconcilePendingRef.current = true;
          }
        }
      } else {
        // HA is namespace-scoped: always authorise via the namespace
        // ownership-proof path, whether or not the namespace already has
        // contexts. Attaching a real context_id here routes the request
        // onto the cloud's legacy "real-context" branch, which gates on
        // the `UserContext` ledger — a table the namespace-native pivot
        // stopped populating, so it 404s ("Contexts not found or not
        // owned by user") for any context that actually exists. An empty
        // group list keeps the request on the server-verified
        // namespace-ownership gate (UserNamespace); core admits the
        // ReadOnlyTee fleet member at the root and auto-follows contexts.
        await enableHaForNamespace(token, settings.nodeUrl, nsId, []);
        setHaEnabled((prev) => ({ ...prev, [nsId]: true }));
        toast.success('HA enabled — TEE fleet nodes will join');
      }
    } catch (err: any) {
      if (err instanceof CloudSessionExpiredError) {
        toast.error('Cloud session expired — reconnect in Settings');
      } else {
        toast.error(err.message || 'Failed to toggle HA');
      }
    } finally {
      setHaEnabling((prev) => { const next = { ...prev }; delete next[nsId]; return next; });
    }
  }, [haEnabled, mero, toast, triggerReconcile]);

  // ── Nav ──
  const openNamespace = (ns: Namespace) => { setActionsMenuOpen(false); setView({ type: "namespace", ns }); };
  const openGroup = (ns: Namespace, groupId: string) => { setActionsMenuOpen(false); setView({ type: "group", ns, groupId }); };
  const goBack = () => {
    setActionsMenuOpen(false);
    if (view.type === "group") setView({ type: "namespace", ns: view.ns });
    else if (view.type === "namespace") setView({ type: "list" });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  const truncateId = (id: string) =>
    id.length > 16 ? `${id.slice(0, 8)}...${id.slice(-8)}` : id;

  const roleColor = (role: string) => {
    switch (role.toLowerCase()) {
      case "admin": return "var(--accent-primary, #a5ff11)";
      case "readonly": return "var(--text-tertiary, #666)";
      default: return "var(--text-secondary, #999)";
    }
  };

  // ── Context row helper ──
  const renderContextItem = (c: any, _applicationId: string, _refetch: () => void) => {
    const hasName = !!c.name;
    return (
      <div key={c.contextId} className="ns-context-item">
        <Box size={14} />
        <div className="ns-row-info">
          {hasName ? (
            <>
              <span className="ns-row-name">{c.name}</span>
              <span className="ns-row-id">{truncateId(c.contextId)}</span>
            </>
          ) : (
            <span className="ns-row-name mono">{truncateId(c.contextId)}</span>
          )}
        </div>
        <button className="copy-btn" onClick={() => copyToClipboard(c.contextId)} title="Copy ID">
          <Copy size={12} />
        </button>
      </div>
    );
  };

  // ── Modals ──
  const modalOverlay = (
    <>
      {nsModalOpen && (
        <CreateNamespaceModal
          installedApps={installedApps}
          loading={creatingNamespace}
          onClose={() => setNsModalOpen(false)}
          onSubmit={onCreateNamespace}
        />
      )}
      {ctxModalOpen && (
        <CreateContextModal
          namespaceId={ctxModalOpen.namespaceId}
          applicationId={ctxModalOpen.applicationId}
          loading={creatingContext}
          onClose={() => setCtxModalOpen(null)}
          onSubmit={(serviceName, alias, initArgs) =>
            onCreateContext(ctxModalOpen.namespaceId, ctxModalOpen.applicationId, serviceName, alias, initArgs)
          }
        />
      )}
      {deleteNsTarget && (
        <DeleteConfirmModal
          title="Delete Namespace"
          warning="Deleting will also remove all subgroups, contexts and members."
          name={nsDisplayName(deleteNsTarget)}
          loading={actionLoading}
          onClose={() => setDeleteNsTarget(null)}
          onConfirm={() => handleDeleteNamespace(deleteNsTarget)}
        />
      )}
      {deleteGroupTarget && (
        <DeleteConfirmModal
          title="Delete Group"
          warning="Deleting will also remove all subgroups, contexts and members."
          name={truncateId(deleteGroupTarget)}
          loading={actionLoading}
          onClose={() => setDeleteGroupTarget(null)}
          onConfirm={() => handleDeleteGroup(deleteGroupTarget)}
        />
      )}
      {deleteContextTarget && (
        <DeleteConfirmModal
          title="Delete Context"
          warning="This context and all associated data will be permanently removed."
          name={deleteContextTarget.name}
          loading={actionLoading}
          onClose={() => setDeleteContextTarget(null)}
          onConfirm={() => handleDeleteContext(deleteContextTarget.contextId, deleteContextTarget.refetch)}
        />
      )}
      {removeMemberTarget && (
        <DeleteConfirmModal
          title="Remove Member"
          warning="This member will lose access to the group."
          name={removeMemberTarget.name}
          loading={actionLoading}
          confirmLabel="Remove"
          onClose={() => setRemoveMemberTarget(null)}
          onConfirm={() => handleRemoveMember(removeMemberTarget.groupId, removeMemberTarget.identity, removeMemberTarget.onSuccess)}
        />
      )}
      {inviteModal && (
        <InviteModal
          groupId={inviteModal.groupId}
          isNamespace={inviteModal.isNamespace}
          mero={mero}
          onClose={() => setInviteModal(null)}
        />
      )}
      {joinNsModal && (
        <JoinNamespaceModal
          loading={actionLoading}
          onClose={() => setJoinNsModal(false)}
          onSubmit={handleJoinNamespace}
        />
      )}
      {joinCtxModal && (
        <JoinContextModal
          loading={actionLoading}
          onClose={() => setJoinCtxModal(null)}
          onSubmit={(contextId) => handleJoinContext(contextId, joinCtxModal.refetch)}
        />
      )}
    </>
  );

  // ─── Namespace List View ───
  if (view.type === "list") {
    return (
      <>
      <div className="ns-page">
        <main className="ns-main">
          <div className="ns-page-top">
            <div className="ns-page-top-left">
              <h1>Namespaces</h1>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="ns-invite-btn"
                onClick={() => setJoinNsModal(true)}
                title="Join an existing namespace using an invitation"
              >
                <LogIn size={14} /> Join Namespace
              </button>
              <button
                className="ns-action-btn"
                style={{ marginLeft: 0 }}
                onClick={() => setNsModalOpen(true)}
                disabled={installedApps.length === 0}
                title={installedApps.length === 0 ? "Install an application first" : "Create a new namespace"}
              >
                <Plus size={14} /> Create Namespace
              </button>
            </div>
          </div>
          {error && <div className="error-message">{error.message}</div>}
          {loading ? (
            <div className="loading">Loading namespaces...</div>
          ) : !error && namespaces.length === 0 ? (
            <div className="empty-state">
              <Globe size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
              <p>No namespaces found</p>
              <p style={{ fontSize: "0.85rem" }}>
                Create a namespace bound to an installed application, then create a context inside it.
              </p>
              {installedApps.length === 0 ? (
                <p style={{ fontSize: "0.85rem", opacity: 0.7 }}>Install an application first (Marketplace).</p>
              ) : (
                <button className="ns-action-btn" onClick={() => setNsModalOpen(true)} style={{ marginTop: 12 }}>
                  <Plus size={14} /> Create Namespace
                </button>
              )}
            </div>
          ) : (
            <div className="ns-grid">
              {namespaces.map((ns) => (
                <div
                  key={ns.namespaceId}
                  className="ns-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => openNamespace(ns)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openNamespace(ns); }}
                >
                  <div className="ns-card-header">
                    <h3>{nsDisplayName(ns)}</h3>
                    <ChevronRight size={16} className="ns-card-chevron" />
                  </div>
                  <div className="ns-card-id" title={ns.namespaceId}>
                    {truncateId(ns.namespaceId)}
                    <button
                      className="copy-btn"
                      onClick={(e) => { e.stopPropagation(); copyToClipboard(ns.namespaceId); }}
                      title="Copy ID"
                    >
                      <Copy size={12} />
                    </button>
                  </div>
                  <div className="ns-card-stats">
                    <span title="Groups"><Layers size={14} /> {(ns as any).subgroupCount ?? 0}</span>
                    <span title="Members"><Users size={14} /> {(ns as any).memberCount ?? 0}</span>
                    <span title="Contexts"><Box size={14} /> {(ns as any).contextCount ?? 0}</span>
                  </div>
                  {ns.upgradePolicy && (
                    <div className="ns-card-policy">
                      <Shield size={12} /> {ns.upgradePolicy}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
      {modalOverlay}
      </>
    );
  }

  // ─── Namespace Detail View ───
  if (view.type === "namespace") {
    const { ns } = view;
    return (
      <>
      <div className="ns-page">
        <header className="ns-header">
          <button className="ns-back" onClick={goBack}>
            <ChevronLeft size={16} /> Back
          </button>
        </header>

        <main className="ns-main">
          <div className="ns-page-top">
            <div className="ns-page-top-left">
              <h1>{nsDisplayName(ns)}</h1>
              <div className="ns-header-id">
                {truncateId(ns.namespaceId)}
                <button className="copy-btn" onClick={() => copyToClipboard(ns.namespaceId)} title="Copy ID">
                  <Copy size={12} />
                </button>
              </div>
            </div>
            <div className="ns-actions-menu-wrapper" ref={actionsMenuRef}>
              <button
                className={`ns-actions-menu-btn${actionsMenuOpen ? ' open' : ''}`}
                onClick={() => setActionsMenuOpen((o) => !o)}
                title="Actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {actionsMenuOpen && (
                <div className="ns-actions-menu">
                  <button className="ns-actions-menu-item" onClick={() => { setActionsMenuOpen(false); setCtxModalOpen({ namespaceId: ns.namespaceId, applicationId: ns.targetApplicationId }); }}>
                    <Plus size={13} /> Create Context
                  </button>
                  <button className="ns-actions-menu-item" onClick={() => { setActionsMenuOpen(false); setJoinCtxModal({ groupId: ns.namespaceId, refetch: () => refetchNsRootContexts?.() }); }}>
                    <LogIn size={13} /> Join Context
                  </button>
                  <button className="ns-actions-menu-item" onClick={() => { setActionsMenuOpen(false); setInviteModal({ groupId: ns.namespaceId, isNamespace: true }); }}>
                    <Link size={13} /> Invite
                  </button>
                  <button className="ns-actions-menu-item ns-actions-menu-item-danger" onClick={() => { setActionsMenuOpen(false); setDeleteNsTarget(ns); }}>
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="ns-detail-stats">
            <button
              className="stat-card stat-card-clickable"
              onClick={() => document.getElementById('ns-members-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <div className="stat-value">{nsMembersLoading ? '…' : nsMembers.length}</div>
              <div className="stat-label">Members ↓</div>
            </button>
            <div className="stat-card">
              <div className="stat-value">{nsRootContexts.length}</div>
              <div className="stat-label">Contexts</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{nsLoadingGroups ? '…' : nsGroups.length}</div>
              <div className="stat-label">Groups</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{ fontSize: "0.85rem" }}>{ns.upgradePolicy || "—"}</div>
              <div className="stat-label">Upgrade Policy</div>
            </div>
          </div>

          <div className="ns-detail-section">
            <h2>Application</h2>
            <div className="ns-detail-field">
              <span className="field-label">Target Application</span>
              <div className="ns-row-info">
                {appById[ns.targetApplicationId]?.name ? (
                  <>
                    <span className="ns-row-name">{appById[ns.targetApplicationId]!.name}</span>
                    <span className="ns-row-id">{truncateId(ns.targetApplicationId)}</span>
                  </>
                ) : (
                  <span className="ns-row-name mono">{truncateId(ns.targetApplicationId)}</span>
                )}
              </div>
              <button className="copy-btn" onClick={() => copyToClipboard(ns.targetApplicationId)} title="Copy">
                <Copy size={12} />
              </button>
            </div>
          </div>

          <div className="ns-detail-section">
            <h2><Box size={16} /> Contexts ({nsRootContexts.length})</h2>
            {nsRootContexts.length === 0 ? (
              <p className="empty-hint">No contexts yet. Click "Create Context" to add one.</p>
            ) : (
              <div className="ns-context-list">
                {nsRootContexts.map((c: any) => renderContextItem(c, ns.targetApplicationId, () => refetchNsRootContexts?.()))}
              </div>
            )}
          </div>

          {cloudEnabled && (() => {
            const cloudConnected = !!getCloudIdToken();
            const nsHaEnabled = !!haEnabled[ns.namespaceId];
            const nsHaEnabling = !!haEnabling[ns.namespaceId];
            return (
              <div className="ns-detail-section ns-ha-section">
                <div className="ns-ha-header">
                  <Shield size={18} className="ns-ha-icon" />
                  <div>
                    <h2>High Availability</h2>
                    <p className="ha-description">
                      Enable TEE replication to have fleet nodes automatically join and replicate
                      your namespace data. Requires a Calimero Cloud account with a paid plan.
                    </p>
                  </div>
                  <div className="ha-badge-wrap">
                    <span className={`ha-badge ${nsHaEnabled ? 'ha-badge-enabled' : 'ha-badge-disabled'}`}>
                      {nsHaEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                </div>
                {!cloudConnected && !nsHaEnabled && (
                  <div className="ha-cloud-required-banner">
                    <Globe size={13} className="ha-cloud-banner-icon" />
                    <span>Connect to Calimero Cloud first — <strong>Settings → Cloud</strong></span>
                  </div>
                )}
                <div className="ha-toggle-row">
                  <button
                    className={`ha-toggle-btn ${nsHaEnabled ? 'ha-enabled' : ''}`}
                    onClick={() => toggleHa(ns)}
                    disabled={nsHaEnabling || (!cloudConnected && !nsHaEnabled)}
                  >
                    {nsHaEnabling ? 'Working...' : nsHaEnabled ? 'Disable HA' : 'Enable High Availability'}
                  </button>
                </div>
              </div>
            );
          })()}

          <div id="ns-members-section" className="ns-detail-section">
            <h2><Users size={16} /> Members ({nsMembersLoading ? '…' : nsMembers.length})</h2>
            {nsMembersLoading ? (
              <p className="empty-hint">Loading members…</p>
            ) : nsMembers.length === 0 ? (
              <p className="empty-hint">No members</p>
            ) : (
              <div className="ns-member-list">
                {nsMembers.map((m) => {
                  const isExpanded = expandedMemberId === m.identity;
                  const hasName = !!m.name;
                  return (
                    <div key={m.identity} className={`ns-member-item ns-member-clickable${isExpanded ? ' ns-member-expanded' : ''}`}>
                      <div className="ns-member-row" onClick={() => setExpandedMemberId(isExpanded ? null : m.identity)}>
                        <div className="member-info">
                          <div className="member-name-row">
                            {hasName ? (
                              <span className="member-name">{m.name}</span>
                            ) : (
                              <span className="member-name mono">{truncateId(m.identity)}</span>
                            )}
                            {myIdentity && m.identity === myIdentity && <span className="ns-me-badge">you</span>}
                          </div>
                          {hasName && <span className="member-id mono">{truncateId(m.identity)}</span>}
                        </div>
                        <span className="member-role" style={{ color: roleColor(m.role) }}>{m.role}</span>
                        <button
                          className="ns-danger-icon-btn"
                          title="Remove member"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRemoveMemberTarget({
                              groupId: ns.namespaceId,
                              identity: m.identity,
                              name: m.name || truncateId(m.identity),
                              onSuccess: () => setNsMembersVersion((v) => v + 1),
                            });
                          }}
                        >
                          <UserMinus size={13} />
                        </button>
                        <ChevronRight size={14} className={`member-chevron${isExpanded ? ' member-chevron-open' : ''}`} />
                      </div>
                      {isExpanded && (
                        <div className="ns-member-detail">
                          <div className="ns-member-detail-row">
                            <span className="ns-member-detail-label">Full Identity</span>
                            <div className="ns-member-detail-value">
                              <span className="mono ns-member-full-id">{m.identity}</span>
                              <button className="copy-btn" onClick={(e) => { e.stopPropagation(); copyToClipboard(m.identity); }} title="Copy full identity">
                                <Copy size={12} />
                              </button>
                            </div>
                          </div>
                          <div className="ns-member-detail-row">
                            <span className="ns-member-detail-label">Role</span>
                            <span className="ns-member-detail-value" style={{ color: roleColor(m.role) }}>{m.role}</span>
                          </div>
                          {m.name && (
                            <div className="ns-member-detail-row">
                              <span className="ns-member-detail-label">Name</span>
                              <span className="ns-member-detail-value">{m.name}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="ns-detail-section">
            <h2>Groups</h2>
            {nsLoadingGroups ? (
              <div className="loading">Loading groups...</div>
            ) : nsGroupsError ? (
              <div className="error-message">{nsGroupsError.message}</div>
            ) : nsGroups.length === 0 ? (
              <p className="empty-hint">No groups in this namespace</p>
            ) : (
              <div className="ns-group-list">
                {nsGroups.map((g: any) => {
                  const gName = (g as any).name || (g as any).metadata?.name;
                  return (
                    <div key={g.groupId} className="ns-group-item">
                      <Layers size={16} />
                      <div
                        className="ns-row-info"
                        onClick={() => openGroup(ns, g.groupId)}
                        style={{ cursor: 'pointer' }}
                      >
                        {gName ? (
                          <>
                            <span className="ns-row-name">{gName}</span>
                            <span className="ns-row-id">{truncateId(g.groupId)}</span>
                          </>
                        ) : (
                          <span className="ns-row-name mono">{truncateId(g.groupId)}</span>
                        )}
                      </div>
                      <button
                        className="ns-danger-icon-btn"
                        title="Delete group"
                        onClick={(e) => { e.stopPropagation(); setDeleteGroupTarget(g.groupId); }}
                      >
                        <Trash2 size={13} />
                      </button>
                      <ChevronRight size={14} className="ns-card-chevron" onClick={() => openGroup(ns, g.groupId)} style={{ cursor: 'pointer' }} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
      {modalOverlay}
      </>
    );
  }

  // ─── Group Detail View ───
  if (view.type === "group") {
    const { ns, groupId } = view;
    const safeGroupMembers = Array.isArray(groupMembers) ? groupMembers : [];
    return (
      <>
      <div className="ns-page">
        <header className="ns-header">
          <button className="ns-back" onClick={goBack}>
            <ChevronLeft size={16} /> Back to {nsDisplayName(ns)}
          </button>
        </header>

        <main className="ns-main">
          <div className="ns-page-top">
            <div className="ns-page-top-left">
              <h1>{groupInfo?.metadata?.name || truncateId(groupId)}</h1>
              <div className="ns-header-id">
                {truncateId(groupId)}
                <button className="copy-btn" onClick={() => copyToClipboard(groupId)} title="Copy ID">
                  <Copy size={12} />
                </button>
              </div>
            </div>
            <div className="ns-actions-menu-wrapper" ref={actionsMenuRef}>
              <button
                className={`ns-actions-menu-btn${actionsMenuOpen ? ' open' : ''}`}
                onClick={() => setActionsMenuOpen((o) => !o)}
                title="Actions"
              >
                <MoreHorizontal size={16} />
              </button>
              {actionsMenuOpen && (
                <div className="ns-actions-menu">
                  <button className="ns-actions-menu-item" onClick={() => { setActionsMenuOpen(false); setJoinCtxModal({ groupId, refetch: () => refetchGroupContexts?.() }); }}>
                    <LogIn size={13} /> Join Context
                  </button>
                  <button className="ns-actions-menu-item" onClick={() => { setActionsMenuOpen(false); setInviteModal({ groupId, isNamespace: false }); }}>
                    <Link size={13} /> Invite
                  </button>
                  <button className="ns-actions-menu-item ns-actions-menu-item-danger" onClick={() => { setActionsMenuOpen(false); setDeleteGroupTarget(groupId); }}>
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              )}
            </div>
          </div>

          {groupLoading ? (
            <div className="loading">Loading group details...</div>
          ) : (
            <>
              {groupInfo && (
                <div className="ns-detail-stats">
                  <div className="stat-card">
                    <div className="stat-value">{groupInfo.memberCount ?? 0}</div>
                    <div className="stat-label">Members</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{groupInfo.contextCount ?? 0}</div>
                    <div className="stat-label">Contexts</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value" style={{ fontSize: "0.85rem" }}>{groupInfo.upgradePolicy || "—"}</div>
                    <div className="stat-label">Upgrade Policy</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value" style={{ fontSize: "0.85rem" }}>{groupInfo.subgroupVisibility || "—"}</div>
                    <div className="stat-label">Visibility</div>
                  </div>
                </div>
              )}

              <div className="ns-detail-section">
                <h2><Users size={16} /> Members ({safeGroupMembers.length})</h2>
                {safeGroupMembers.length === 0 ? (
                  <p className="empty-hint">No members</p>
                ) : (
                  <div className="ns-member-list">
                    {safeGroupMembers.map((m: any) => {
                      const hasName = !!m.name;
                      return (
                      <div key={m.identity} className="ns-member-item">
                        <div className="ns-member-row">
                          <div className="member-info">
                            <div className="member-name-row">
                              {hasName ? (
                                <span className="member-name">{m.name}</span>
                              ) : (
                                <span className="member-name mono">{truncateId(m.identity)}</span>
                              )}
                              {myIdentity && m.identity === myIdentity && <span className="ns-me-badge">you</span>}
                            </div>
                            {hasName && <span className="member-id mono">{truncateId(m.identity)}</span>}
                          </div>
                          <span className="member-role" style={{ color: roleColor(m.role) }}>{m.role}</span>
                          <button className="copy-btn" onClick={() => copyToClipboard(m.identity)} title="Copy identity">
                            <Copy size={12} />
                          </button>
                          <button
                            className="ns-danger-icon-btn"
                            title="Remove member"
                            onClick={() => setRemoveMemberTarget({
                              groupId,
                              identity: m.identity,
                              name: m.name || truncateId(m.identity),
                              onSuccess: () => refetchGroupMembers?.(),
                            })}
                          >
                            <UserMinus size={13} />
                          </button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="ns-detail-section">
                <h2><Box size={16} /> Contexts ({groupContexts.length})</h2>
                {groupContexts.length === 0 ? (
                  <p className="empty-hint">No contexts in this group</p>
                ) : (
                  <div className="ns-context-list">
                    {groupContexts.map((c: any) => renderContextItem(c, ns.targetApplicationId, () => refetchGroupContexts?.()))}
                  </div>
                )}
              </div>

              {groupSubgroups.length > 0 && (
                <div className="ns-detail-section">
                  <h2><Layers size={16} /> Subgroups ({groupSubgroups.length})</h2>
                  <div className="ns-group-list">
                    {groupSubgroups.map((g: any) => {
                      const gName = (g as any).name || (g as any).metadata?.name;
                      return (
                        <div key={g.groupId} className="ns-group-item">
                          <Layers size={16} />
                          <div
                            className="ns-row-info"
                            onClick={() => openGroup(ns, g.groupId)}
                            style={{ cursor: 'pointer' }}
                          >
                            {gName ? (
                              <>
                                <span className="ns-row-name">{gName}</span>
                                <span className="ns-row-id">{truncateId(g.groupId)}</span>
                              </>
                            ) : (
                              <span className="ns-row-name mono">{truncateId(g.groupId)}</span>
                            )}
                          </div>
                          <button
                            className="ns-danger-icon-btn"
                            title="Delete subgroup"
                            onClick={() => setDeleteGroupTarget(g.groupId)}
                          >
                            <Trash2 size={13} />
                          </button>
                          <ChevronRight size={14} className="ns-card-chevron" onClick={() => openGroup(ns, g.groupId)} style={{ cursor: 'pointer' }} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {modalOverlay}
      </>
    );
  }

  return null;
}

// ─── Modals ───

interface CreateNamespaceModalProps {
  installedApps: InstalledApp[];
  loading: boolean;
  onClose: () => void;
  onSubmit: (applicationId: string, alias: string | undefined) => void;
}

function CreateNamespaceModal({ installedApps, loading, onClose, onSubmit }: CreateNamespaceModalProps) {
  const [applicationId, setApplicationId] = useState(installedApps[0]?.id ?? "");
  const [alias, setAlias] = useState("");
  const [appDropdownOpen, setAppDropdownOpen] = useState(false);
  const appDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!appDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (appDropdownRef.current && !appDropdownRef.current.contains(e.target as Node)) {
        setAppDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [appDropdownOpen]);

  const selectedApp = installedApps.find((a) => a.id === applicationId);

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create Namespace">
        <div className="ns-modal-header">
          <h2>Create Namespace</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <form
          className="ns-modal-body"
          onSubmit={(e) => { e.preventDefault(); if (!applicationId) return; onSubmit(applicationId, alias); }}
        >
          <div className="ns-modal-field">
            <span>Application</span>
            <div className="ns-app-select-wrapper" ref={appDropdownRef}>
              <button
                type="button"
                className={`ns-app-select-trigger${appDropdownOpen ? ' open' : ''}`}
                onClick={() => setAppDropdownOpen((o) => !o)}
                disabled={installedApps.length === 0}
              >
                <span className="ns-app-select-name">
                  {selectedApp ? selectedApp.name : 'No applications installed'}
                </span>
                <ChevronDown size={14} className={`ns-app-select-chevron${appDropdownOpen ? ' open' : ''}`} />
              </button>
              {appDropdownOpen && installedApps.length > 0 && (
                <div className="ns-app-select-menu">
                  {installedApps.map((app) => (
                    <button
                      key={app.id}
                      type="button"
                      className={`ns-app-select-option${app.id === applicationId ? ' selected' : ''}`}
                      onClick={() => { setApplicationId(app.id); setAppDropdownOpen(false); }}
                    >
                      <span className="ns-app-select-option-name">{app.name}</span>
                      <span className="ns-app-select-option-id mono">{app.id.slice(0, 8)}…</span>
                      {app.id === applicationId && <Check size={13} className="ns-app-select-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <label className="ns-modal-field">
            <div className="ns-modal-field-header">
              <span>Alias (optional)</span>
              <span className="ns-char-counter">{alias.length}/64</span>
            </div>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value.slice(0, 64))}
              maxLength={64}
              placeholder="e.g. my-namespace"
            />
          </label>
          <p className="ns-modal-hint">
            Upgrade policy: <code>Automatic</code>. Default capabilities (create context, invite, manage members) will be applied to new members.
          </p>
          <div className="ns-modal-actions">
            <button type="button" className="ns-modal-cancel" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="ns-action-btn" disabled={loading || !applicationId}>
              {loading ? "Creating..." : "Create Namespace"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface CreateContextModalProps {
  namespaceId: string;
  applicationId: string;
  loading: boolean;
  onClose: () => void;
  onSubmit: (serviceName: string, alias: string | undefined, initArgs: string) => void;
}

function CreateContextModal({ namespaceId, applicationId, loading, onClose, onSubmit }: CreateContextModalProps) {
  const [serviceName, setServiceName] = useState("");
  const [alias, setAlias] = useState("");
  const [initArgs, setInitArgs] = useState("");
  const [argsError, setArgsError] = useState<string | null>(null);

  const validateArgs = (val: string) => {
    if (!val.trim()) { setArgsError(null); return; }
    try { JSON.parse(val); setArgsError(null); }
    catch { setArgsError("Invalid JSON"); }
  };

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create Context">
        <div className="ns-modal-header">
          <h2>Create Context</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <form
          className="ns-modal-body"
          onSubmit={(e) => { e.preventDefault(); if (argsError) return; onSubmit(serviceName, alias || undefined, initArgs); }}
        >
          <div className="ns-modal-readonly">
            <div><strong>Namespace:</strong> <code>{namespaceId.slice(0, 8)}…{namespaceId.slice(-8)}</code></div>
            <div><strong>Application:</strong> <code>{applicationId.slice(0, 8)}…{applicationId.slice(-8)}</code></div>
          </div>
          <label className="ns-modal-field">
            <span>Service name <span className="ns-optional">(optional)</span></span>
            <input type="text" value={serviceName} onChange={(e) => setServiceName(e.target.value)} placeholder="e.g. lobby" />
          </label>
          <label className="ns-modal-field">
            <span>Alias <span className="ns-optional">(optional)</span></span>
            <input type="text" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="e.g. main-lobby" />
          </label>
          <label className="ns-modal-field">
            <span>Init arguments <span className="ns-optional">(optional JSON)</span></span>
            <textarea
              className={`ns-modal-textarea${argsError ? ' ns-input-error' : ''}`}
              value={initArgs}
              onChange={(e) => { setInitArgs(e.target.value); validateArgs(e.target.value); }}
              onBlur={() => validateArgs(initArgs)}
              placeholder='{}'
              rows={3}
              spellCheck={false}
            />
            {argsError && <span className="ns-field-error">{argsError}</span>}
          </label>
          <div className="ns-modal-actions">
            <button type="button" className="ns-modal-cancel" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="ns-action-btn" disabled={loading || !!argsError}>
              {loading ? "Creating..." : "Create Context"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DeleteConfirmModalProps {
  title: string;
  warning: string;
  name: string;
  loading: boolean;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
}

function DeleteConfirmModal({ title, warning, name, loading, confirmLabel = "Delete", onClose, onConfirm }: DeleteConfirmModalProps) {
  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="ns-modal-header">
          <h2>{title}</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="ns-modal-body">
          <div className="ns-delete-warning">
            <p className="ns-delete-name">{name}</p>
            <p className="ns-delete-msg">{warning}</p>
            <p className="ns-delete-final">This action cannot be undone.</p>
          </div>
          <div className="ns-modal-actions">
            <button className="ns-modal-cancel" onClick={onClose} disabled={loading}>Cancel</button>
            <button className="ns-delete-confirm-btn" onClick={onConfirm} disabled={loading}>
              {loading ? 'Deleting...' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface JoinNamespaceModalProps {
  loading: boolean;
  onClose: () => void;
  onSubmit: (invitationText: string) => void;
}

function JoinNamespaceModal({ loading, onClose, onSubmit }: JoinNamespaceModalProps) {
  const [payload, setPayload] = useState('');

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal ns-modal-wide" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="ns-modal-header">
          <h2>Join Namespace</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <form
          className="ns-modal-body"
          onSubmit={(e) => { e.preventDefault(); if (!payload.trim()) return; onSubmit(payload.trim()); }}
        >
          <p className="ns-modal-hint">Paste the invitation payload you received from a namespace admin.</p>
          <label className="ns-modal-field">
            <span>Invitation Payload</span>
            <textarea
              className="ns-invite-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="Paste invitation payload here..."
              rows={4}
              spellCheck={false}
              autoFocus
            />
          </label>
          <div className="ns-modal-actions">
            <button type="button" className="ns-modal-cancel" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="ns-action-btn" disabled={loading || !payload.trim()}>
              {loading ? 'Joining...' : 'Join Namespace'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface JoinContextModalProps {
  loading: boolean;
  onClose: () => void;
  onSubmit: (invitationText: string) => void;
}

function JoinContextModal({ loading, onClose, onSubmit }: JoinContextModalProps) {
  const [payload, setPayload] = useState('');

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal ns-modal-wide" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="ns-modal-header">
          <h2>Join Context</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <form
          className="ns-modal-body"
          onSubmit={(e) => { e.preventDefault(); if (!payload.trim()) return; onSubmit(payload.trim()); }}
        >
          <p className="ns-modal-hint">Paste the invitation payload you received from a context admin.</p>
          <label className="ns-modal-field">
            <span>Invitation Payload</span>
            <textarea
              className="ns-invite-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="Paste invitation payload here..."
              rows={4}
              spellCheck={false}
              autoFocus
            />
          </label>
          <div className="ns-modal-actions">
            <button type="button" className="ns-modal-cancel" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="ns-action-btn" disabled={loading || !payload.trim()}>
              {loading ? 'Joining...' : 'Join Context'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface InviteModalProps {
  groupId: string;
  isNamespace: boolean;
  mero: ReturnType<typeof useMero>["mero"];
  onClose: () => void;
}

function InviteModal({ groupId, isNamespace, mero, onClose }: InviteModalProps) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [invitationPayload, setInvitationPayload] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!mero) return;
    setLoading(true);
    try {
      const result = isNamespace
        ? await mero.admin.createNamespaceInvitation(groupId)
        : await mero.admin.createGroupInvitation(groupId);
      setInvitationPayload(btoa(JSON.stringify(result)));
    } catch (e: any) {
      toast.error(`Failed to create invitation: ${parseApiError(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const copyInvitation = () => {
    if (invitationPayload) {
      navigator.clipboard.writeText(invitationPayload);
      toast.success('Invitation copied to clipboard');
    }
  };

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal ns-modal-wide" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="ns-modal-header">
          <h2>Create Invitation</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="ns-modal-body">
          {!invitationPayload ? (
            <>
              <div className="ns-modal-readonly">
                <div><strong>{isNamespace ? 'Namespace' : 'Group'}:</strong> <code>{groupId.slice(0, 8)}…{groupId.slice(-8)}</code></div>
              </div>
              <p className="ns-modal-hint">Generate an invitation payload that someone can use to join this {isNamespace ? 'namespace' : 'group'}.</p>
              <div className="ns-modal-actions">
                <button className="ns-modal-cancel" onClick={onClose} disabled={loading}>Cancel</button>
                <button className="ns-action-btn" onClick={handleCreate} disabled={loading}>
                  {loading ? 'Creating...' : 'Create Invitation'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="ns-modal-hint">Share this payload with the person you want to invite.</p>
              <div className="ns-modal-field">
                <span>Invitation Payload</span>
                <textarea
                  className="ns-invite-payload"
                  readOnly
                  value={invitationPayload}
                  rows={4}
                  onClick={(e) => (e.target as HTMLTextAreaElement).select()}
                />
              </div>
              <div className="ns-modal-actions">
                <button className="ns-modal-cancel" onClick={onClose}>Close</button>
                <button className="ns-action-btn" onClick={copyInvitation}>
                  <Copy size={14} /> Copy Payload
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
