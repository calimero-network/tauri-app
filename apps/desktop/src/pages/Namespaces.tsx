import { useState, useEffect, useCallback } from "react";
import { apiClient } from "@calimero-network/mero-react";
import { useToast } from "../contexts/ToastContext";
import { ArrowLeft, Users, Box, Layers, Copy, ChevronRight, Shield, Globe } from "lucide-react";
import "./Namespaces.css";

interface Namespace {
  namespaceId: string;
  appKey: string;
  targetApplicationId: string;
  upgradePolicy: string;
  createdAt: number;
  alias?: string;
  memberCount: number;
  contextCount: number;
  subgroupCount: number;
}

interface GroupInfo {
  groupId: string;
  appKey: string;
  targetApplicationId: string;
  upgradePolicy: string;
  memberCount: number;
  contextCount: number;
  defaultCapabilities: number;
  defaultVisibility: string;
  alias?: string;
}

interface GroupMember {
  identity: string;
  role: string;
  alias?: string;
}

interface GroupContextEntry {
  contextId: string;
  alias?: string;
}

interface SubgroupEntry {
  groupId: string;
  alias?: string;
}

type View =
  | { type: "list" }
  | { type: "namespace"; ns: Namespace }
  | { type: "group"; ns: Namespace; groupId: string };

export default function Namespaces() {
  const toast = useToast();
  const admin = apiClient.meroJs.admin;

  // Top-level state
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ type: "list" });

  // Namespace detail state
  const [nsGroups, setNsGroups] = useState<SubgroupEntry[]>([]);
  const [nsLoadingGroups, setNsLoadingGroups] = useState(false);

  // Group detail state
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [groupContexts, setGroupContexts] = useState<GroupContextEntry[]>([]);
  const [groupSubgroups, setGroupSubgroups] = useState<SubgroupEntry[]>([]);
  const [groupLoading, setGroupLoading] = useState(false);

  // Load namespaces
  const loadNamespaces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await admin.listNamespaces();
      const list = (response as unknown as { namespaces?: Namespace[] })?.namespaces
        ?? (Array.isArray(response) ? response : []);
      setNamespaces(list);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load namespaces";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [admin]);

  useEffect(() => {
    loadNamespaces();
  }, [loadNamespaces]);

  // Load namespace groups when viewing a namespace
  const loadNamespaceGroups = useCallback(async (nsId: string) => {
    setNsLoadingGroups(true);
    try {
      const groups = await admin.listNamespaceGroups(nsId);
      setNsGroups(Array.isArray(groups) ? groups : []);
    } catch {
      setNsGroups([]);
    } finally {
      setNsLoadingGroups(false);
    }
  }, [admin]);

  // Load group details when viewing a group
  const loadGroupDetails = useCallback(async (groupId: string) => {
    setGroupLoading(true);
    try {
      const [info, members, contexts, subgroups] = await Promise.all([
        admin.getGroupInfo(groupId).catch(() => null),
        admin.listGroupMembers(groupId).catch(() => ({ data: [], selfIdentity: null })),
        admin.listGroupContexts(groupId).catch(() => []),
        admin.listSubgroups(groupId).catch(() => []),
      ]);
      setGroupInfo(info as unknown as GroupInfo | null);
      const memberList = (members as unknown as { data?: GroupMember[] })?.data ?? (Array.isArray(members) ? members : []);
      setGroupMembers(memberList);
      setGroupContexts(Array.isArray(contexts) ? contexts : []);
      setGroupSubgroups(Array.isArray(subgroups) ? subgroups : []);
    } catch {
      toast.error("Failed to load group details");
    } finally {
      setGroupLoading(false);
    }
  }, [admin, toast]);

  // View transitions
  const openNamespace = (ns: Namespace) => {
    setView({ type: "namespace", ns });
    loadNamespaceGroups(ns.namespaceId);
  };

  const openGroup = (ns: Namespace, groupId: string) => {
    setView({ type: "group", ns, groupId });
    loadGroupDetails(groupId);
  };

  const goBack = () => {
    if (view.type === "group") {
      setView({ type: "namespace", ns: view.ns });
      loadNamespaceGroups(view.ns.namespaceId);
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
          {error && <div className="error-message">{error}</div>}
          {loading ? (
            <div className="loading">Loading namespaces...</div>
          ) : namespaces.length === 0 ? (
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
                <button
                  key={ns.namespaceId}
                  className="ns-card"
                  onClick={() => openNamespace(ns)}
                >
                  <div className="ns-card-header">
                    <h3>{ns.alias || truncateId(ns.namespaceId)}</h3>
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
                    <span title="Groups"><Layers size={14} /> {ns.subgroupCount ?? 0}</span>
                    <span title="Members"><Users size={14} /> {ns.memberCount}</span>
                    <span title="Contexts"><Box size={14} /> {ns.contextCount}</span>
                  </div>
                  {ns.upgradePolicy && (
                    <div className="ns-card-policy">
                      <Shield size={12} /> {ns.upgradePolicy}
                    </div>
                  )}
                </button>
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
            <h1>{ns.alias || truncateId(ns.namespaceId)}</h1>
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
              <div className="stat-value">{ns.memberCount}</div>
              <div className="stat-label">Members</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{ns.contextCount}</div>
              <div className="stat-label">Contexts</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{ns.subgroupCount ?? 0}</div>
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
            <h2>Groups</h2>
            {nsLoadingGroups ? (
              <div className="loading">Loading groups...</div>
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
                    <span className="group-name">{g.alias || truncateId(g.groupId)}</span>
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
            <ArrowLeft size={16} /> Back to {ns.alias || "namespace"}
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
                    <div className="stat-value">{groupInfo.memberCount}</div>
                    <div className="stat-label">Members</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{groupInfo.contextCount}</div>
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
                          <span className="member-name">{m.alias || truncateId(m.identity)}</span>
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
                        <span className="context-name">{c.alias || truncateId(c.contextId)}</span>
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
                        <span className="group-name">{g.alias || truncateId(g.groupId)}</span>
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
