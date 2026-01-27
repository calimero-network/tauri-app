import React, { useState, useEffect, useMemo } from "react";
import { apiClient } from "@calimero-network/mero-react";
import { useToast } from "../contexts/ToastContext";
import DataTable from "../components/DataTable";
import { SkeletonTable } from "../components/Skeleton";
import { X } from "lucide-react";
import "./Contexts.css";

interface Context {
  id: string;
  applicationId?: string;
  application_id?: string; // Support both camelCase and snake_case
  rootHash?: string;
  root_hash?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, any>;
  createdAt?: string;
  updatedAt?: string;
}

interface InstalledApp {
  id: string;
  name?: string;
  version?: string;
  metadata?: number[] | string; // Can be array of bytes or base64 string
}

export interface ContextsProps {
  onAuthRequired?: () => void;
  onConfirmDelete?: (contextId: string, contextName: string, onConfirm: () => Promise<void>) => void;
}

const Contexts: React.FC<ContextsProps> = ({ onAuthRequired, onConfirmDelete }) => {
  const toast = useToast();
  const [contexts, setContexts] = useState<Context[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createProtocol, setCreateProtocol] = useState("near");
  const [createApplicationId, setCreateApplicationId] = useState("");
  const [createInitializationParams, setCreateInitializationParams] = useState("");
  const [creating, setCreating] = useState(false);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);

  useEffect(() => {
    loadContexts();
    loadInstalledApps();
  }, []);

  const loadInstalledApps = async () => {
    setLoadingApps(true);
    try {
      const response = await apiClient.node.listApplications();
      console.log("📦 Contexts: listApplications response:", response);
      
      if (response.error) {
        // If 401, trigger login redirect
        if (response.error.code === '401') {
          console.warn("📦 Contexts: 401 Unauthorized - token may be expired");
          if (onAuthRequired) {
            onAuthRequired();
          } else {
            window.location.reload();
          }
          return;
        }
        setError(response.error.message);
        return;
      }
      
      if (response.data && Array.isArray(response.data)) {
        console.log("📦 Contexts: Setting installed apps:", response.data);
        setInstalledApps(response.data);
      } else {
        console.warn("📦 Contexts: No apps data or not an array:", response.data);
      }
    } catch (err: any) {
      // Check for 401 in error object
      if (err?.status === 401 || err?.code === '401') {
        console.warn("📦 Contexts: 401 Unauthorized - triggering login");
        onAuthRequired?.();
        return;
      }
      console.error("Failed to load installed apps:", err);
      setError(err instanceof Error ? err.message : "Failed to load installed apps");
    } finally {
      setLoadingApps(false);
    }
  };

  const loadContexts = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.node.getContexts();
      if (response.error) {
        // If 401, trigger login redirect
        if (response.error.code === '401') {
          console.warn("📦 Contexts: 401 Unauthorized - token may be expired");
          if (onAuthRequired) {
            onAuthRequired();
          } else {
            window.location.reload();
          }
          return;
        }
        setError(response.error.message);
        setContexts([]);
        return;
      }

      if (response.data) {
        const contextsList = Array.isArray(response.data) 
          ? response.data 
          : [];
        console.log("📦 Contexts loaded:", contextsList);
        setContexts(contextsList);
      }
    } catch (err: any) {
      // Check for 401 in error object
      if (err?.status === 401 || err?.code === '401') {
        console.warn("📦 Contexts: 401 Unauthorized - triggering login");
        onAuthRequired?.();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load contexts");
      console.error("Failed to load contexts:", err);
      setContexts([]);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateContext = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!createApplicationId.trim()) {
      setError("Application ID is required");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      // Convert initialization params from JSON string to byte array
      let initParams: number[] = [];
      if (createInitializationParams.trim()) {
        try {
          const jsonParams = JSON.parse(createInitializationParams.trim());
          const jsonString = JSON.stringify(jsonParams);
          initParams = Array.from(new TextEncoder().encode(jsonString));
        } catch (parseErr) {
          setError("Invalid JSON in initialization params");
          setCreating(false);
          return;
        }
      }

      const response = await apiClient.node.createContext({
        protocol: createProtocol,
        applicationId: createApplicationId.trim(),
        initializationParams: initParams,
      });

      if (response.error) {
        setError(`Failed to create context: ${response.error.message}`);
        return;
      }

      toast.success(`Context created successfully! ID: ${response.data?.contextId || 'N/A'}`);
      setCreateProtocol("near");
      setCreateApplicationId("");
      setCreateInitializationParams("");
      setShowCreateForm(false);
      await loadContexts();
    } catch (err) {
      setError(`Failed to create context: ${err instanceof Error ? err.message : "Unknown error"}`);
      console.error("Create context error:", err);
    } finally {
      setCreating(false);
    }
  };

  // Get app alias for display
  const getAppAlias = (appId: string): string => {
    const app = installedApps.find(a => a.id === appId);
    if (!app) return appId;
    
    try {
      let metadata: any = {};
      if (typeof app.metadata === 'string') {
        metadata = JSON.parse(atob(app.metadata));
      } else if (Array.isArray(app.metadata)) {
        metadata = JSON.parse(String.fromCharCode(...app.metadata));
      } else if (app.metadata) {
        metadata = app.metadata;
      }
      
      return metadata.name || metadata.alias || app.name || appId;
    } catch (e) {
      return app.name || appId;
    }
  };

  // Prepare contexts for table with app names
  const contextsWithAppNames = useMemo(() => {
    return contexts.map(context => ({
      ...context,
      appAlias: getAppAlias(context.applicationId || context.application_id || 'unknown'),
    }));
  }, [contexts, installedApps]);

  const handleDeleteContext = async (contextId: string, contextName: string) => {
    if (onConfirmDelete) {
      onConfirmDelete(contextId, contextName, async () => {
        try {
          console.log(`🗑️ Deleting context: ${contextId}`);
          const response = await apiClient.node.deleteContext(contextId);
          
          if (response.error) {
            toast.error(`Failed to delete context: ${response.error.message}`);
            return;
          }

          console.log(`✅ Context deleted successfully: ${response.data?.contextId || contextId}`);
          toast.success(`Context "${contextName}" deleted successfully`);
          // Reload the list
          await loadContexts();
        } catch (err) {
          console.error("Delete context error:", err);
          setError(`Failed to delete context: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      });
    } else {
      // Fallback if onConfirmDelete is not provided
      try {
        console.log(`🗑️ Deleting context: ${contextId}`);
        const response = await apiClient.node.deleteContext(contextId);
        
        if (response.error) {
          toast.error(`Failed to delete context: ${response.error.message}`);
          return;
        }

        console.log(`✅ Context deleted successfully: ${response.data?.contextId || contextId}`);
        toast.success(`Context "${contextName}" deleted successfully`);
        await loadContexts();
      } catch (err) {
        console.error("Delete context error:", err);
        setError(`Failed to delete context: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }
  };

  return (
    <div className="contexts-page">
      <header className="contexts-header">
        <h1>Contexts</h1>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button 
            onClick={() => setShowCreateForm(!showCreateForm)} 
            className="button button-primary"
          >
            {showCreateForm ? "Cancel" : "+ Create Context"}
          </button>
          <button onClick={loadContexts} className="button" disabled={loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </header>

      <main className="contexts-main">
        {error && (
          <div className="error-message" style={{ marginBottom: '16px' }}>
            {error}
            <button 
              onClick={() => setError(null)} 
              style={{ marginLeft: '12px', padding: '4px 8px', fontSize: '12px', display: 'inline-flex', alignItems: 'center' }}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {showCreateForm && (
          <div className="create-context-form">
            <h2>Create New Context</h2>
            <form onSubmit={handleCreateContext}>
              <div className="form-group">
                <label htmlFor="context-protocol">Protocol *</label>
                <select
                  id="context-protocol"
                  value={createProtocol}
                  onChange={(e) => setCreateProtocol(e.target.value)}
                  required
                  disabled={creating}
                >
                  <option value="near">NEAR</option>
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="context-application-id">Application ID *</label>
                <select
                  id="context-application-id"
                  value={createApplicationId}
                  onChange={(e) => setCreateApplicationId(e.target.value)}
                  required
                  disabled={creating || loadingApps}
                >
                  <option value="">Select an application...</option>
                  {installedApps.length > 0 ? (
                    installedApps.map((app) => {
                      // Decode metadata to get name if available
                      let appName = app.id;
                      let appVersion = '';
                      
                      if (app.metadata) {
                        try {
                          // Handle empty metadata (bundles use empty metadata)
                          if (Array.isArray(app.metadata) && app.metadata.length === 0) {
                            // Empty metadata for bundles - use app.id as name
                            appName = app.id;
                            appVersion = '';
                          } else {
                            const metadata = typeof app.metadata === 'string' 
                              ? JSON.parse(atob(app.metadata))
                              : Array.isArray(app.metadata)
                              ? JSON.parse(String.fromCharCode(...app.metadata))
                              : app.metadata;
                            appName = metadata.name || metadata.alias || app.id;
                            appVersion = metadata.version || '';
                          }
                        } catch (e) {
                          console.warn("Failed to decode app metadata:", e);
                          // Fallback to app.id if parsing fails
                          appName = app.id;
                          appVersion = '';
                        }
                      }
                      
                      return (
                        <option key={app.id} value={app.id}>
                          {appName} {appVersion ? `(${appVersion})` : ''}
                        </option>
                      );
                    })
                  ) : (
                    <option value="" disabled>
                      {loadingApps ? "Loading apps..." : "No apps installed"}
                    </option>
                  )}
                </select>
                {installedApps.length === 0 && !loadingApps && (
                  <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    No installed applications. Install an app from the Marketplace first.
                  </p>
                )}
                {loadingApps && (
                  <p style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    Loading installed applications...
                  </p>
                )}
              </div>
              <div className="form-group">
                <label htmlFor="context-init-params">Initialization Params (JSON)</label>
                <textarea
                  id="context-init-params"
                  value={createInitializationParams}
                  onChange={(e) => setCreateInitializationParams(e.target.value)}
                  placeholder='Enter initialization params as JSON (e.g., {"key": "value"})'
                  rows={4}
                  disabled={creating}
                />
              </div>
              <div className="form-actions">
                <button type="submit" className="button button-primary" disabled={creating}>
                  {creating ? "Creating..." : "Create Context"}
                </button>
                <button 
                  type="button" 
                  onClick={() => {
                    setShowCreateForm(false);
                    setCreateProtocol("near");
                    setCreateApplicationId("");
                    setCreateInitializationParams("");
                  }}
                  className="button"
                  disabled={creating}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {loading ? (
          <SkeletonTable rows={5} columns={6} showHeader={true} />
        ) : (
          <DataTable
            data={contextsWithAppNames}
            columns={[
              {
                key: 'name',
                label: 'Name',
                sortable: true,
                width: '20%',
                sortValue: (context) => context.name || context.id, // Sort by actual name or full id
                render: (context) => {
                  const name = context.name || context.id.substring(0, 16) + '...';
                  return (
                    <div className="table-cell-name">
                      <div className="table-cell-primary">{name}</div>
                    </div>
                  );
                },
              },
              {
                key: 'appAlias',
                label: 'Application',
                sortable: true,
                width: '20%',
                render: (context) => {
                return (
                    <div className="table-cell-primary">
                      {context.appAlias || 'Unknown'}
                    </div>
                  );
                },
              },
              {
                key: 'id',
                label: 'Context ID',
                sortable: true,
                width: '25%',
                sortValue: (context) => context.id, // Sort by full ID (already correct, but explicit)
                render: (context) => {
                  return (
                    <div className="table-cell-secondary" style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      {context.id.substring(0, 32)}...
                          </div>
                  );
                },
              },
              {
                key: 'rootHash',
                label: 'Root Hash',
                sortable: false,
                width: '15%',
                render: (context) => {
                  const hash = context.rootHash || context.root_hash;
                  if (!hash) return <span className="table-cell-empty">—</span>;
                  return (
                    <div className="table-cell-secondary" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                      {hash.substring(0, 16)}...
                              </div>
                  );
                },
              },
              {
                key: 'createdAt',
                label: 'Created',
                sortable: true,
                width: '12%',
                sortValue: (context) => {
                  // Sort by timestamp value (newer dates sort higher)
                  return context.createdAt ? new Date(context.createdAt).getTime() : 0;
                },
                render: (context) => {
                  if (!context.createdAt) return <span className="table-cell-empty">—</span>;
                  const date = new Date(context.createdAt);
                  return (
                    <div className="table-cell-secondary" style={{ fontSize: '12px' }}>
                      {date.toLocaleDateString()}
                      <br />
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                        {date.toLocaleTimeString()}
                      </span>
                          </div>
                  );
                },
              },
              {
                key: 'actions',
                label: 'Actions',
                sortable: false,
                width: '8%',
                render: (context) => {
                  const contextName = context.name || context.id.substring(0, 16) + '...';
                  return (
                    <div className="table-cell-actions">
                            <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteContext(context.id, contextName);
                        }}
                        className="button button-danger button-small"
                            >
                              Delete
                            </button>
                  </div>
                );
                },
              },
            ]}
            keyExtractor={(context) => context.id}
            emptyMessage={
              <div className="empty-state">
                <p>No contexts found.</p>
                <p>Click "Create Context" to create your first context.</p>
          </div>
            }
          />
        )}
      </main>
    </div>
  );
};

export default Contexts;

