import { useState, useEffect, useCallback } from "react";
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
import { useToast } from "../contexts/ToastContext";
import { ChevronLeft, Users, Box, Layers, Copy, ChevronRight, Shield, Globe, Plus, X, Play } from "lucide-react";
import { apiClient } from "../lib/mero-client";
import { saveContextKey, getContextKey } from "../utils/contextKeys";
import { decodeMetadata, openAppFrontend } from "../utils/appUtils";
import { getSettings } from "../utils/settings";
import {
  enableHaForNamespace,
  disableHaNamespace,
  getCloudGroups,
  CloudSessionExpiredError,
} from "../utils/cloudApi";
import { getCloudIdToken } from "../utils/cloudAuth";
import { isCloudEnabled } from "../utils/featureFlags";
import "./Namespaces.css";

// Same default as battleships: CAN_CREATE_CONTEXT (1) | CAN_INVITE_MEMBERS (2) | MANAGE_MEMBERS (8).
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

export default function Namespaces() {
  const toast = useToast();
  const { mero } = useMero();
  const [view, setView] = useState<View>({ type: "list" });

  // Current namespace/group IDs for hooks
  const activeNsId = view.type === "namespace" || view.type === "group" ? view.ns.namespaceId : null;
  const activeGroupId = view.type === "group" ? view.groupId : null;
  const activeNsRootId = view.type === "namespace" ? view.ns.namespaceId : null;

  // Hooks
  const { namespaces, loading, error, refetch: refetchNamespaces } = useNamespaces();
  const { groups: nsGroups, loading: nsLoadingGroups, error: nsGroupsError } = useNamespaceGroups(activeNsId);
  const { groupInfo, loading: groupInfoLoading } = useGroupInfo(activeGroupId);
  const { groupInfo: nsRootGroupInfo } = useGroupInfo(activeNsRootId);
  const { members: groupMembers } = useGroupMembers(activeGroupId);
  const [nsMembers, setNsMembers] = useState<any[]>([]);
  const [nsMembersLoading, setNsMembersLoading] = useState(false);

  useEffect(() => {
    if (!activeNsRootId) { setNsMembers([]); return; }
    const settings = getSettings();
    const token = localStorage.getItem('calimero_access_token');
    if (!settings.nodeUrl || !token) return;
    setNsMembersLoading(true);
    fetch(`${settings.nodeUrl}/admin-api/groups/${activeNsRootId}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((json) => {
        const members = json?.members ?? json?.data?.members ?? [];
        setNsMembers(Array.isArray(members) ? members : []);
      })
      .catch(() => { setNsMembers([]); })
      .finally(() => setNsMembersLoading(false));
  }, [activeNsRootId]);
  const { contexts: groupContexts, refetch: refetchGroupContexts } = useGroupContexts(activeGroupId);
  // Contexts that live directly in a namespace's root group (battleships-style lobby contexts)
  const { contexts: nsRootContexts, refetch: refetchNsRootContexts } = useGroupContexts(
    view.type === "namespace" ? view.ns.namespaceId : null,
  );
  const { subgroups: groupSubgroups = [] } = useSubgroups(activeGroupId);

  const { createNamespace, loading: creatingNamespace } = useCreateNamespace();
  const [creatingContext, setCreatingContext] = useState(false);

  // Installed apps (loaded lazily for the Create-Namespace dropdown)
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

  // Modals
  const [nsModalOpen, setNsModalOpen] = useState(false);
  const [ctxModalOpen, setCtxModalOpen] = useState<{ namespaceId: string; applicationId: string } | null>(null);
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);

  const groupLoading = groupInfoLoading;

  const onCreateNamespace = async (applicationId: string, alias: string | undefined) => {
    if (!mero) {
      toast.error("Node client not ready");
      return;
    }
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
        alias: alias?.trim() || undefined,
      });
      if (!result) throw new Error('createContext returned null');
      saveContextKey(result.contextId, result.memberPublicKey, applicationId);
      toast.success(`Context created: ${truncateId(result.contextId)}`);
      setCtxModalOpen(null);
      await Promise.all([
        refetchGroupContexts?.(),
        refetchNsRootContexts?.(),
      ]);
    } catch (e: any) {
      const msg = e?.bodyText ?? e?.message ?? String(e);
      toast.error(`Failed to create context: ${msg}`);
    } finally {
      setCreatingContext(false);
    }
  };

  const handleLaunchContext = async (contextId: string, applicationId: string) => {
    const app = installedApps.find((a) => a.id === applicationId);
    if (!app?.frontendUrl) {
      toast.error("This application has no frontend URL");
      return;
    }
    const key = getContextKey(contextId);
    await openAppFrontend(app.frontendUrl, app.name, undefined, {
      applicationId,
      contextId,
      executorPublicKey: key?.publicKey,
    });
  };

  // HA state — keyed by namespaceId. A namespace is HA-enabled when the
  // cloud reports ha_status === "enabled" for it (namespace-scoped — the
  // cloud collapses HA to one record per namespace; post Phase 4 the
  // payload also carries zero-context namespaces). `haEnabling` is a
  // per-namespace map (not a single boolean) so toggling one namespace
  // doesn't lock every other toggle.
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
        // Root-only, SDK-skew-safe probe. We deliberately do NOT
        // enumerate namespace groups/subgroups here anymore:
        //
        //  • Namespace-proof is the HA authority for the context-less
        //    case (Phase 1, #80). enableHaForNamespace already routes an
        //    empty group list to requestNamespaceOwnershipProof +
        //    enableHaNamespace(nsId, [], proof) — admin-of-root proof
        //    authorises the whole namespace, and core auto-follow
        //    propagates fleet membership into subgroups. Group/subgroup
        //    enumeration was legacy context-native bookkeeping and is
        //    being decoupled here (pulling a slice of Phase 4 forward).
        //  • Skew safety: bundled mero-js 1.4.0's listNamespaceGroups
        //    throws "This namespace has no groups" against a
        //    core-master/rc.40 node, and it was only ever reached on the
        //    context-less path — exactly the path we now hand straight
        //    to the namespace proof. listGroupContexts(nsId) is the one
        //    call confirmed working against core master.
        //
        // Intentional behavioural change (NOT a regression): a namespace
        // whose contexts live ONLY in subgroups (root group empty) now
        // takes the namespace-proof path instead of the per-context
        // claim path. This is consistent with the namespace-native
        // model — admin-of-root proof authorises the whole namespace and
        // core auto-follow propagates fleet membership into subgroups;
        // per-context registration via /contexts/claim remains a
        // separate concern handled elsewhere.
        // .catch(() => []) is intentional, NOT silent error-swallowing:
        // bundled mero-js 1.4.0 throws on namespace/group enumeration
        // against newer core nodes (known packaging skew), so this probe
        // is best-effort only. On error/empty we deliberately fall
        // through to the context-less path, which is authorised
        // server-side by a merod-signed namespace ownership proof (Phase
        // 1) — the canonical HA authz, not a bypass/downgrade. Phase 4
        // decouples HA from context registration, so this fallthrough is
        // intended. Ref: NAMESPACE_NATIVE_READMODEL_PLAN.md §4.2. The
        // failure is now warn-logged so non-skew probe failures stay
        // visible for diagnosis.
        const rootCtxs = await mero.admin
          .listGroupContexts(nsId)
          .catch((err: unknown) => {
            console.warn(
              'listGroupContexts probe failed; treating namespace as context-less and falling through to the namespace-ownership-proof path (expected under mero-js↔core skew):',
              err,
            );
            return [] as { contextId: string }[];
          });
        const groups = rootCtxs.length
          ? [{ group_id: nsId, context_id: rootCtxs[0].contextId }]
          : [];
        await enableHaForNamespace(token, settings.nodeUrl, nsId, groups);
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
    </>
  );

  // ─── Namespace List View ───
  if (view.type === "list") {
    return (
      <>
      <div className="ns-page">
        <header className="ns-header">
          <h1>Namespaces</h1>
          <button
            className="ns-action-btn"
            onClick={() => setNsModalOpen(true)}
            disabled={installedApps.length === 0}
            title={installedApps.length === 0 ? "Install an application first" : "Create a new namespace"}
          >
            <Plus size={14} /> Create Namespace
          </button>
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
                Create a namespace bound to an installed application, then create a context inside it.
              </p>
              {installedApps.length === 0 ? (
                <p style={{ fontSize: "0.85rem", opacity: 0.7 }}>
                  Install an application first (Marketplace).
                </p>
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
          <div style={{ flex: 1 }}>
            <h1>{nsDisplayName(ns)}</h1>
            <div className="ns-header-id">
              {truncateId(ns.namespaceId)}
              <button className="copy-btn" onClick={() => copyToClipboard(ns.namespaceId)} title="Copy ID">
                <Copy size={12} />
              </button>
            </div>
          </div>
          <button
            className="ns-action-btn"
            onClick={() => setCtxModalOpen({ namespaceId: ns.namespaceId, applicationId: ns.targetApplicationId })}
          >
            <Plus size={14} /> Create Context
          </button>
        </header>

        <main className="ns-main">
          <div className="ns-detail-stats">
            <button
              className="stat-card stat-card-clickable"
              onClick={() => document.getElementById('ns-members-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <div className="stat-value">{nsMembersLoading ? '…' : nsMembers.length > 0 ? nsMembers.length : ((ns as any).memberCount ?? 0)}</div>
              <div className="stat-label">Members ↓</div>
            </button>
            <div className="stat-card">
              <div className="stat-value">{nsRootContexts.length > 0 ? nsRootContexts.length : ((ns as any).contextCount ?? 0)}</div>
              <div className="stat-label">Contexts</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{nsGroups.length > 0 ? nsGroups.length : ((ns as any).subgroupCount ?? 0)}</div>
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
            <h2><Box size={16} /> Contexts ({nsRootContexts.length})</h2>
            {nsRootContexts.length === 0 ? (
              <p className="empty-hint">No contexts in this namespace yet. Click "Create Context" to add one.</p>
            ) : (
              <div className="ns-context-list">
                {nsRootContexts.map((c: any) => {
                  const app = installedApps.find((a) => a.id === ns.targetApplicationId);
                  const canLaunch = !!app?.frontendUrl;
                  return (
                    <div key={c.contextId} className="ns-context-item">
                      <Box size={14} />
                      <span className="context-name">{c.name || truncateId(c.contextId)}</span>
                      <span className="context-id mono">{truncateId(c.contextId)}</span>
                      <button className="copy-btn" onClick={() => copyToClipboard(c.contextId)} title="Copy ID">
                        <Copy size={12} />
                      </button>
                      {canLaunch && (
                        <button
                          className="ns-launch-btn"
                          onClick={() => handleLaunchContext(c.contextId, ns.targetApplicationId)}
                          title={`Launch ${app?.name ?? "app"} with this context`}
                        >
                          <Play size={12} /> Launch
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {isCloudEnabled() && (() => {
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
                    title={!cloudConnected && !nsHaEnabled ? 'Connect to Calimero Cloud first (Settings → Cloud)' : undefined}
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
                  return (
                    <div key={m.identity} className={`ns-member-item ns-member-clickable${isExpanded ? ' ns-member-expanded' : ''}`}>
                      <div className="ns-member-row" onClick={() => setExpandedMemberId(isExpanded ? null : m.identity)}>
                        <div className="member-info">
                          <span className="member-name">{m.name || truncateId(m.identity)}</span>
                          <span className="member-id mono">{truncateId(m.identity)}</span>
                        </div>
                        <span className="member-role" style={{ color: roleColor(m.role) }}>
                          {m.role}
                        </span>
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
                {nsGroups.map((g) => (
                  <button
                    key={g.groupId}
                    className="ns-group-item"
                    onClick={() => openGroup(ns, g.groupId)}
                  >
                    <Layers size={16} />
                    <span className="group-name">{(g as any).name || (g as any).metadata?.name || truncateId(g.groupId)}</span>
                    <span className="group-id mono">{truncateId(g.groupId)}</span>
                    <ChevronRight size={14} className="ns-card-chevron" />
                  </button>
                ))}
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
    return (
      <>
      <div className="ns-page">
        <header className="ns-header">
          <button className="ns-back" onClick={goBack}>
            <ChevronLeft size={16} /> Back to {nsDisplayName(ns)}
          </button>
          <div>
            <h1>{groupInfo?.metadata?.name || truncateId(groupId)}</h1>
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
                    <div className="stat-value" style={{ fontSize: "0.85rem" }}>{groupInfo.subgroupVisibility || "—"}</div>
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
                          <span className="member-name">{m.name || truncateId(m.identity)}</span>
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
                    {groupContexts.map((c: any) => {
                      const app = installedApps.find((a) => a.id === ns.targetApplicationId);
                      const canLaunch = !!app?.frontendUrl;
                      return (
                        <div key={c.contextId} className="ns-context-item">
                          <Box size={14} />
                          <span className="context-name">{c.name || truncateId(c.contextId)}</span>
                          <span className="context-id mono">{truncateId(c.contextId)}</span>
                          <button className="copy-btn" onClick={() => copyToClipboard(c.contextId)} title="Copy ID">
                            <Copy size={12} />
                          </button>
                          {canLaunch && (
                            <button
                              className="ns-launch-btn"
                              onClick={() => handleLaunchContext(c.contextId, ns.targetApplicationId)}
                              title={`Launch ${app?.name ?? "app"} with this context`}
                            >
                              <Play size={12} /> Launch
                            </button>
                          )}
                        </div>
                      );
                    })}
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
                        <span className="group-name">{(g as any).name || (g as any).metadata?.name || truncateId(g.groupId)}</span>
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

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create Namespace">
        <div className="ns-modal-header">
          <h2>Create Namespace</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form
          className="ns-modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (!applicationId) return;
            onSubmit(applicationId, alias);
          }}
        >
          <label className="ns-modal-field">
            <span>Application</span>
            <select
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
              required
            >
              {installedApps.length === 0 && <option value="">No applications installed</option>}
              {installedApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
            </select>
          </label>
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
            <button type="button" className="ns-modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
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

  const canSubmit = !argsError;

  return (
    <div className="ns-modal-backdrop" onClick={onClose}>
      <div className="ns-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Create Context">
        <div className="ns-modal-header">
          <h2>Create Context</h2>
          <button className="ns-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form
          className="ns-modal-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            onSubmit(serviceName, alias || undefined, initArgs);
          }}
        >
          <div className="ns-modal-readonly">
            <div><strong>Namespace:</strong> <code>{namespaceId.slice(0, 8)}…{namespaceId.slice(-8)}</code></div>
            <div><strong>Application:</strong> <code>{applicationId.slice(0, 8)}…{applicationId.slice(-8)}</code></div>
          </div>
          <label className="ns-modal-field">
            <span>Service name <span className="ns-optional">(optional)</span></span>
            <input
              type="text"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder="e.g. lobby"
            />
          </label>
          <label className="ns-modal-field">
            <span>Alias <span className="ns-optional">(optional)</span></span>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. main-lobby"
            />
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
            <button type="button" className="ns-modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="ns-action-btn" disabled={loading || !canSubmit}>
              {loading ? "Creating..." : "Create Context"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
