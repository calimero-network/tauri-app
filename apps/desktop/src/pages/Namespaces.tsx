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
  useCreateContext,
  type Namespace,
} from "@calimero-network/mero-react";
import { useToast } from "../contexts/ToastContext";
import { ArrowLeft, Users, Box, Layers, Copy, ChevronRight, Shield, Globe, Plus, X, Play } from "lucide-react";
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

  // Hooks
  const { namespaces, loading, error, refetch: refetchNamespaces } = useNamespaces();
  const { groups: nsGroups, loading: nsLoadingGroups, error: nsGroupsError } = useNamespaceGroups(activeNsId);
  const { groupInfo, loading: groupInfoLoading } = useGroupInfo(activeGroupId);
  const { members: groupMembers } = useGroupMembers(activeGroupId);
  const { contexts: groupContexts, refetch: refetchGroupContexts } = useGroupContexts(activeGroupId);
  // Contexts that live directly in a namespace's root group (battleships-style lobby contexts)
  const { contexts: nsRootContexts, refetch: refetchNsRootContexts } = useGroupContexts(
    view.type === "namespace" ? view.ns.namespaceId : null,
  );
  const { subgroups: groupSubgroups } = useSubgroups(activeGroupId);

  const { createNamespace, loading: creatingNamespace } = useCreateNamespace();
  const { createContext, loading: creatingContext } = useCreateContext();

  // Installed apps (loaded lazily for the Create-Namespace dropdown)
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  useEffect(() => {
    readInstalledApps().then(setInstalledApps).catch(() => setInstalledApps([]));
  }, []);

  // Modals
  const [nsModalOpen, setNsModalOpen] = useState(false);
  const [ctxModalOpen, setCtxModalOpen] = useState<{ namespaceId: string; applicationId: string } | null>(null);

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
        alias: alias?.trim() || undefined,
      });
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
  ) => {
    try {
      const result = await createContext({
        applicationId,
        groupId: namespaceId,
        serviceName: serviceName.trim() || undefined,
        initializationParams: [],
        alias: alias?.trim() || undefined,
      });
      if (!result) throw new Error("createContext returned null");
      saveContextKey(result.contextId, result.memberPublicKey, applicationId);
      toast.success(`Context created: ${truncateId(result.contextId)}`);
      setCtxModalOpen(null);
      await Promise.all([
        refetchGroupContexts?.(),
        refetchNsRootContexts?.(),
      ]);
    } catch (e: any) {
      toast.error(`Failed to create context: ${e?.message ?? String(e)}`);
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
        const rootCtxs = await mero.admin
          .listGroupContexts(nsId)
          .catch(() => [] as { contextId: string }[]);
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
          onSubmit={(serviceName, alias) =>
            onCreateContext(ctxModalOpen.namespaceId, ctxModalOpen.applicationId, serviceName, alias)
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
            <ArrowLeft size={16} /> Back
          </button>
          <div style={{ flex: 1 }}>
            <h1>{(ns as any).alias || truncateId(ns.namespaceId)}</h1>
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
                      <span className="context-name">{c.alias || truncateId(c.contextId)}</span>
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

          {isCloudEnabled() && (
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
          )}

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
                    {groupContexts.map((c: any) => {
                      const app = installedApps.find((a) => a.id === ns.targetApplicationId);
                      const canLaunch = !!app?.frontendUrl;
                      return (
                        <div key={c.contextId} className="ns-context-item">
                          <Box size={14} />
                          <span className="context-name">{c.alias || truncateId(c.contextId)}</span>
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
            <span>Alias (optional)</span>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
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
  onSubmit: (serviceName: string, alias: string | undefined) => void;
}

function CreateContextModal({ namespaceId, applicationId, loading, onClose, onSubmit }: CreateContextModalProps) {
  const [serviceName, setServiceName] = useState("");
  const [alias, setAlias] = useState("");

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
            onSubmit(serviceName, alias);
          }}
        >
          <div className="ns-modal-readonly">
            <div><strong>Namespace:</strong> <code>{namespaceId.slice(0, 8)}…{namespaceId.slice(-8)}</code></div>
            <div><strong>Application:</strong> <code>{applicationId.slice(0, 8)}…{applicationId.slice(-8)}</code></div>
          </div>
          <label className="ns-modal-field">
            <span>Service name (optional)</span>
            <input
              type="text"
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder="e.g. lobby"
            />
          </label>
          <label className="ns-modal-field">
            <span>Alias (optional)</span>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. main-lobby"
            />
          </label>
          <div className="ns-modal-actions">
            <button type="button" className="ns-modal-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="ns-action-btn" disabled={loading}>
              {loading ? "Creating..." : "Create Context"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
