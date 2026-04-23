import { useState, useEffect, useCallback } from "react";
import {
  useMero,
  useNamespaces,
  useNamespaceGroups,
  useGroupInfo,
  useGroupMembers,
  useGroupContexts,
  useSubgroups,
  type Namespace,
} from "@calimero-network/mero-react";
import { useToast } from "../contexts/ToastContext";
import { ArrowLeft, Users, Box, Layers, Copy, ChevronRight, Shield, Globe } from "lucide-react";
import { getSettings } from "../utils/settings";
import {
  enableHaForNamespace,
  disableHaNamespace,
  getCloudGroups,
  CloudSessionExpiredError,
  type NamespaceHaGroup,
} from "../utils/cloudApi";
import { getCloudIdToken } from "../utils/cloudAuth";
import "./Namespaces.css";

type View =
  | { type: "list" }
  | { type: "namespace"; ns: Namespace }
  | { type: "group"; ns: Namespace; groupId: string };

/**
 * Find any {group_id, context_id} pair owned by the user under this
 * namespace. The manager only stores one HaRequest + HaContextStatus
 * per namespace regardless of how many groups the client sends, so
 * there is no reason to enumerate them all — we just need one entry
 * to attach billing + fleet-join bookkeeping to.
 *
 * Fast path: most namespaces have a context in the root group
 * (group_id === namespace_id), so one admin-API call usually suffices.
 * Fallback: probe subgroups in bounded-concurrency batches and
 * early-exit as soon as one batch returns a match. The old code did
 * O(N) sequential round-trips; bounded batches keep the local admin
 * API from seeing a burst of parallel requests on large namespaces
 * while still amortising latency.
 */
const PROBE_BATCH_SIZE = 6;

async function findRepresentativeHaGroup(
  mero: NonNullable<ReturnType<typeof useMero>["mero"]>,
  namespaceId: string,
): Promise<NamespaceHaGroup> {
  // Fast path failure is tolerated but logged — if it's a real
  // connectivity issue the fallback path's listNamespaceGroups call
  // will surface the same error with proper context. We don't
  // distinguish "404 / no contexts" from other errors here because
  // mero-js doesn't expose a stable error shape to switch on; the
  // warning in dev console is what surfaces the cause.
  const rootCtxs = await mero.admin
    .listGroupContexts(namespaceId)
    .catch((err: unknown) => {
      console.warn(
        `listGroupContexts(${namespaceId}) failed on fast path, falling through to subgroup probe:`,
        err,
      );
      return [] as { contextId: string }[];
    });
  if (rootCtxs.length) {
    return { group_id: namespaceId, context_id: rootCtxs[0].contextId };
  }

  const allGroups = await mero.admin.listNamespaceGroups(namespaceId);
  // Root already proven empty on the fast path — drop it so we don't
  // re-probe it in the fallback.
  const subgroups = allGroups.filter((g) => g.groupId !== namespaceId);
  if (!subgroups.length) {
    throw new Error("This namespace has no groups");
  }

  for (let i = 0; i < subgroups.length; i += PROBE_BATCH_SIZE) {
    const batch = subgroups.slice(i, i + PROBE_BATCH_SIZE);
    const probes = await Promise.all(
      batch.map((g) =>
        mero.admin
          .listGroupContexts(g.groupId)
          .then(
            (ctxs) =>
              ctxs[0]
                ? ({ group_id: g.groupId, context_id: ctxs[0].contextId } as NamespaceHaGroup)
                : null,
            (err: unknown) => {
              // Per-probe failure logged but non-fatal — another
              // subgroup may still resolve. If every probe fails the
              // caller sees the "no context yet" error below, and the
              // dev console has the underlying reason.
              console.warn(`listGroupContexts(${g.groupId}) failed:`, err);
              return null;
            },
          ),
      ),
    );
    const found = probes.find((p): p is NamespaceHaGroup => p !== null);
    if (found) return found;
  }

  throw new Error("No group in this namespace has a context yet");
}

export default function Namespaces() {
  const toast = useToast();
  const { mero } = useMero();
  const [view, setView] = useState<View>({ type: "list" });

  // Current namespace/group IDs for hooks
  const activeNsId = view.type === "namespace" || view.type === "group" ? view.ns.namespaceId : null;
  const activeGroupId = view.type === "group" ? view.groupId : null;

  // Hooks
  const { namespaces, loading, error } = useNamespaces();
  const { groups: nsGroups, loading: nsLoadingGroups, error: nsGroupsError } = useNamespaceGroups(activeNsId);
  const { groupInfo, loading: groupInfoLoading } = useGroupInfo(activeGroupId);
  const { members: groupMembers } = useGroupMembers(activeGroupId);
  const { contexts: groupContexts } = useGroupContexts(activeGroupId);
  const { subgroups: groupSubgroups } = useSubgroups(activeGroupId);

  const groupLoading = groupInfoLoading;

  // HA state — keyed by namespaceId (not groupId). A namespace is
  // considered HA-enabled if at least one of its groups has HA enabled
  // on the cloud side. `haEnabling` is a per-namespace map (not a single
  // boolean) so toggling one namespace doesn't lock every other toggle.
  const [haEnabling, setHaEnabling] = useState<Record<string, boolean>>({});
  const [haEnabled, setHaEnabled] = useState<Record<string, boolean>>({});

  // Hydrate HA state from the cloud so toggles reflect server truth on mount.
  useEffect(() => {
    const token = getCloudIdToken();
    if (!token) return;
    let cancelled = false;
    getCloudGroups(token)
      .then((groups) => {
        if (cancelled) return;
        const byNamespace: Record<string, boolean> = {};
        for (const g of groups) {
          if (!g.namespace_id) continue;
          if (g.ha_status === "enabled") byNamespace[g.namespace_id] = true;
          else if (byNamespace[g.namespace_id] === undefined) byNamespace[g.namespace_id] = false;
        }
        setHaEnabled(byNamespace);
      })
      .catch(() => {
        // Silent — HA toggles will stay in local state until next refresh.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleHa = useCallback(async (ns: Namespace) => {
    const token = getCloudIdToken();
    if (!token) {
      toast.error('Connect to Calimero Cloud first (Settings → Cloud)');
      return;
    }
    const settings = getSettings();
    if (!settings.nodeUrl) {
      toast.error('Node URL not configured');
      return;
    }
    if (!mero) {
      toast.error('Local node client is not ready yet');
      return;
    }

    const nsId = ns.namespaceId;
    const isEnabled = !!haEnabled[nsId];
    setHaEnabling((prev) => ({ ...prev, [nsId]: true }));

    try {
      if (isEnabled) {
        await disableHaNamespace(token, nsId);
        setHaEnabled((prev) => ({ ...prev, [nsId]: false }));
        toast.success('HA disabled — TEE nodes will stop replicating');
      } else {
        // The cloud only needs ONE representative {group_id, context_id}
        // per namespace (post mdma#30 / core rc.29 — one HaRequest row
        // per namespace, auto-follow propagates fleet membership into
        // subgroups). Find one quickly instead of enumerating every
        // subgroup sequentially.
        const haGroup = await findRepresentativeHaGroup(mero, nsId);
        await enableHaForNamespace(token, settings.nodeUrl, nsId, [haGroup]);
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
      setHaEnabling((prev) => {
        const next = { ...prev };
        delete next[nsId];
        return next;
      });
    }
  }, [haEnabled, mero, toast]);

  // View transitions
  const openNamespace = (ns: Namespace) => {
    setView({ type: "namespace", ns });
  };

  const openGroup = (ns: Namespace, groupId: string) => {
    setView({ type: "group", ns, groupId });
  };

  const goBack = () => {
    if (view.type === "group") {
      setView({ type: "namespace", ns: view.ns });
    } else if (view.type === "namespace") {
      setView({ type: "list" });
    }
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

  // ─── Namespace List View ───
  if (view.type === "list") {
    return (
      <div className="ns-page">
        <header className="ns-header">
          <h1>Namespaces</h1>
        </header>
        <main className="ns-main">
          {error && <div className="error-message">{error.message}</div>}
          {loading ? (
            <div className="loading">Loading namespaces...</div>
          ) : !error && namespaces.length === 0 ? (
            <div className="empty-state">
              <Globe size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
              <p>No namespaces found</p>
              <p style={{ fontSize: "0.85rem" }}>
                Namespaces are created when you install an application and create a context.
              </p>
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
                    <h3>{(ns as any).alias || truncateId(ns.namespaceId)}</h3>
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
    );
  }

  // ─── Namespace Detail View ───
  if (view.type === "namespace") {
    const { ns } = view;
    return (
      <div className="ns-page">
        <header className="ns-header">
          <button className="ns-back" onClick={goBack}>
            <ArrowLeft size={16} /> Back
          </button>
          <div>
            <h1>{(ns as any).alias || truncateId(ns.namespaceId)}</h1>
            <div className="ns-header-id">
              {truncateId(ns.namespaceId)}
              <button className="copy-btn" onClick={() => copyToClipboard(ns.namespaceId)} title="Copy ID">
                <Copy size={12} />
              </button>
            </div>
          </div>
        </header>

        <main className="ns-main">
          <div className="ns-detail-stats">
            <div className="stat-card">
              <div className="stat-value">{(ns as any).memberCount ?? 0}</div>
              <div className="stat-label">Members</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{(ns as any).contextCount ?? 0}</div>
              <div className="stat-label">Contexts</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{(ns as any).subgroupCount ?? 0}</div>
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
              <span className="field-value mono">{truncateId(ns.targetApplicationId)}</span>
              <button className="copy-btn" onClick={() => copyToClipboard(ns.targetApplicationId)} title="Copy">
                <Copy size={12} />
              </button>
            </div>
          </div>

          <div className="ns-detail-section">
            <h2><Shield size={16} style={{ marginRight: 6, verticalAlign: -2 }} />High Availability</h2>
            <p className="ha-description">
              Enable TEE replication to have fleet nodes automatically join and replicate
              your namespace data. Requires a Calimero Cloud account with a paid plan.
            </p>
            <div className="ha-toggle-row">
              <span className="ha-status">
                {haEnabled[ns.namespaceId] ? '✓ HA Enabled' : 'HA Disabled'}
              </span>
              <button
                className={`ha-toggle-btn ${haEnabled[ns.namespaceId] ? 'ha-enabled' : ''}`}
                onClick={() => toggleHa(ns)}
                disabled={!!haEnabling[ns.namespaceId]}
              >
                {haEnabling[ns.namespaceId] ? 'Working...' : haEnabled[ns.namespaceId] ? 'Disable HA' : 'Enable HA'}
              </button>
            </div>
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
                {nsGroups.map((g) => (
                  <button
                    key={g.groupId}
                    className="ns-group-item"
                    onClick={() => openGroup(ns, g.groupId)}
                  >
                    <Layers size={16} />
                    <span className="group-name">{(g as any).alias || truncateId(g.groupId)}</span>
                    <span className="group-id mono">{truncateId(g.groupId)}</span>
                    <ChevronRight size={14} className="ns-card-chevron" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ─── Group Detail View ───
  if (view.type === "group") {
    const { ns, groupId } = view;
    return (
      <div className="ns-page">
        <header className="ns-header">
          <button className="ns-back" onClick={goBack}>
            <ArrowLeft size={16} /> Back to {(ns as any).alias || "namespace"}
          </button>
          <div>
            <h1>{groupInfo?.alias || truncateId(groupId)}</h1>
            <div className="ns-header-id">
              {truncateId(groupId)}
              <button className="copy-btn" onClick={() => copyToClipboard(groupId)} title="Copy ID">
                <Copy size={12} />
              </button>
            </div>
          </div>
        </header>

        <main className="ns-main">
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
                    <div className="stat-value" style={{ fontSize: "0.85rem" }}>{groupInfo.defaultVisibility || "—"}</div>
                    <div className="stat-label">Visibility</div>
                  </div>
                </div>
              )}

              {/* Members */}
              <div className="ns-detail-section">
                <h2><Users size={16} /> Members ({groupMembers.length})</h2>
                {groupMembers.length === 0 ? (
                  <p className="empty-hint">No members</p>
                ) : (
                  <div className="ns-member-list">
                    {groupMembers.map((m) => (
                      <div key={m.identity} className="ns-member-item">
                        <div className="member-info">
                          <span className="member-name">{(m as any).alias || truncateId(m.identity)}</span>
                          <span className="member-id mono">{truncateId(m.identity)}</span>
                        </div>
                        <span className="member-role" style={{ color: roleColor(m.role) }}>
                          {m.role}
                        </span>
                        <button className="copy-btn" onClick={() => copyToClipboard(m.identity)} title="Copy identity">
                          <Copy size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Contexts */}
              <div className="ns-detail-section">
                <h2><Box size={16} /> Contexts ({groupContexts.length})</h2>
                {groupContexts.length === 0 ? (
                  <p className="empty-hint">No contexts in this group</p>
                ) : (
                  <div className="ns-context-list">
                    {groupContexts.map((c) => (
                      <div key={c.contextId} className="ns-context-item">
                        <Box size={14} />
                        <span className="context-name">{(c as any).alias || truncateId(c.contextId)}</span>
                        <span className="context-id mono">{truncateId(c.contextId)}</span>
                        <button className="copy-btn" onClick={() => copyToClipboard(c.contextId)} title="Copy ID">
                          <Copy size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Subgroups */}
              {groupSubgroups.length > 0 && (
                <div className="ns-detail-section">
                  <h2><Layers size={16} /> Subgroups ({groupSubgroups.length})</h2>
                  <div className="ns-group-list">
                    {groupSubgroups.map((g) => (
                      <button
                        key={g.groupId}
                        className="ns-group-item"
                        onClick={() => openGroup(ns, g.groupId)}
                      >
                        <Layers size={16} />
                        <span className="group-name">{(g as any).alias || truncateId(g.groupId)}</span>
                        <span className="group-id mono">{truncateId(g.groupId)}</span>
                        <ChevronRight size={14} className="ns-card-chevron" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    );
  }

  return null;
}
