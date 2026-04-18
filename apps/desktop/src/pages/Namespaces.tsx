import { useState, useCallback } from "react";
import {
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
import { enableHaForNamespace, disableHa, CloudSessionExpiredError } from "../utils/cloudApi";
import { getCloudIdToken } from "../utils/cloudAuth";
import "./Namespaces.css";

type View =
  | { type: "list" }
  | { type: "namespace"; ns: Namespace }
  | { type: "group"; ns: Namespace; groupId: string };

export default function Namespaces() {
  const toast = useToast();
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

  // HA state
  const [haEnabling, setHaEnabling] = useState(false);
  const [haEnabled, setHaEnabled] = useState<Record<string, boolean>>({});

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

    const nsId = ns.namespaceId;
    const isEnabled = haEnabled[nsId];
    setHaEnabling(true);

    try {
      if (isEnabled) {
        // Find a context in this namespace to disable HA
        // Use the namespace ID as a proxy context ID for now
        await disableHa(token, nsId);
        setHaEnabled((prev) => ({ ...prev, [nsId]: false }));
        toast.success('HA disabled — TEE nodes will stop replicating');
      } else {
        await enableHaForNamespace(token, settings.nodeUrl, nsId, nsId, {
          acceptMock: true, // Allow mock attestations during development
        });
        setHaEnabled((prev) => ({ ...prev, [nsId]: true }));
        toast.success('HA enabled — TEE fleet nodes will join this namespace');
      }
    } catch (err: any) {
      if (err instanceof CloudSessionExpiredError) {
        toast.error('Cloud session expired — reconnect in Settings');
      } else {
        toast.error(err.message || 'Failed to toggle HA');
      }
    } finally {
      setHaEnabling(false);
    }
  }, [haEnabled, toast]);

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
                disabled={haEnabling}
              >
                {haEnabling ? 'Working...' : haEnabled[ns.namespaceId] ? 'Disable HA' : 'Enable HA'}
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
