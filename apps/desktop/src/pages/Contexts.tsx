import React, { useState, useEffect, useCallback } from "react";
import { apiClient, getAccessToken, getRefreshToken } from "@calimero-network/mero-react";
import { invoke } from "@tauri-apps/api/tauri";
import { getSettings } from "../utils/settings";
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
  clientReady?: boolean;
}

const Contexts: React.FC<ContextsProps> = ({ onAuthRequired, onConfirmDelete, clientReady = true }) => {
  const [contexts, setContexts] = useState<Context[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createProtocol, setCreateProtocol] = useState("near");
  const [createApplicationId, setCreateApplicationId] = useState("");
  const [createInitializationParams, setCreateInitializationParams] = useState("");
  const [creating, setCreating] = useState(false);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);

  useEffect(() => {
    if (clientReady) {
      loadContexts();
      loadInstalledApps();
    }
  }, [clientReady]);

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
    setSuccessMessage(null);
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

      setSuccessMessage(`Context created successfully! ID: ${response.data?.contextId || 'N/A'}`);
      setCreateProtocol("near");
      setCreateApplicationId("");
      setCreateInitializationParams("");
      setShowCreateForm(false);
      await loadContexts();
      
      // Clear success message after 3 seconds
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err) {
      setError(`Failed to create context: ${err instanceof Error ? err.message : "Unknown error"}`);
      console.error("Create context error:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteContext = async (contextId: string, contextName: string) => {
    if (onConfirmDelete) {
      onConfirmDelete(contextId, contextName, async () => {
        try {
          console.log(`🗑️ Deleting context: ${contextId}`);
          const response = await apiClient.node.deleteContext(contextId);
          
          if (response.error) {
            setError(`Failed to delete context: ${response.error.message}`);
            return;
          }

          console.log(`✅ Context deleted successfully: ${response.data?.contextId || contextId}`);
          setSuccessMessage(`Context "${contextName}" deleted successfully`);
          // Reload the list
          await loadContexts();
          // Clear success message after 3 seconds
          setTimeout(() => setSuccessMessage(null), 3000);
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
          setError(`Failed to delete context: ${response.error.message}`);
          return;
        }

        console.log(`✅ Context deleted successfully: ${response.data?.contextId || contextId}`);
        setSuccessMessage(`Context "${contextName}" deleted successfully`);
        await loadContexts();
        // Clear success message after 3 seconds
        setTimeout(() => setSuccessMessage(null), 3000);
      } catch (err) {
        console.error("Delete context error:", err);
        setError(`Failed to delete context: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }
  };

  /**
   * Open the mero-react example app in a Tauri window
   * with existing tokens and context ID passed via URL hash (SSO flow)
   */
  const openFrontend = useCallback(async (contextId: string, applicationId: string) => {
    const accessToken = getAccessToken();
    const refreshToken = getRefreshToken();
    const settings = getSettings();
    
    if (!accessToken || !refreshToken) {
      setError('Not authenticated. Please login first.');
      return;
    }

    const nodeUrl = settings.nodeUrl.replace(/\/$/, '');
    const exampleAppUrl = 'http://localhost:5173';

    // Build URL with tokens and context ID in hash (SSO pattern)
    const params = new URLSearchParams();
    params.set('access_token', accessToken);
    params.set('refresh_token', refreshToken);
    params.set('node_url', nodeUrl);
    params.set('context_id', contextId);
    params.set('application_id', applicationId);
    params.set('expires_in', '3600'); // 1 hour default

    const fullUrl = `${exampleAppUrl}/#${params.toString()}`;
    
    console.log('🚀 Opening frontend with SSO for context:', contextId);
    
    try {
      // Open in a new Tauri window
      const windowLabel = `app-context-${Date.now()}`;
      await invoke('create_app_window', {
        windowLabel,
        url: fullUrl,
        title: `Context: ${contextId.slice(0, 8)}...`,
        nodeUrl: nodeUrl,
      });
      console.log('Opened frontend in Tauri window:', fullUrl);
    } catch (err) {
      console.error('Failed to open frontend:', err);
      setError(`Failed to open frontend: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, []);

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
              style={{ marginLeft: '12px', padding: '4px 8px', fontSize: '12px' }}
            >
              ✕
            </button>
          </div>
        )}
        {successMessage && (
          <div className="success-message" style={{ 
            marginBottom: '16px', 
            padding: '12px', 
            backgroundColor: '#d4edda', 
            color: '#155724', 
            borderRadius: '4px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            {successMessage}
            <button 
              onClick={() => setSuccessMessage(null)} 
              style={{ padding: '4px 8px', fontSize: '12px', background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              ✕
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
          <div className="loading">Loading contexts...</div>
        ) : contexts.length === 0 ? (
          <div className="empty-state">
            <p>No contexts found.</p>
            <p>Click "Create Context" to create your first context.</p>
          </div>
        ) : (
          <div className="contexts-grouped">
            {(() => {
              // Group contexts by application_id
              const grouped = contexts.reduce((acc, context) => {
                const appId = context.applicationId || context.application_id || 'unknown';
                if (!acc[appId]) {
                  acc[appId] = [];
                }
                acc[appId].push(context);
                return acc;
              }, {} as Record<string, Context[]>);

              // Get app alias for each application_id
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
                  
                  return metadata.alias || metadata.name || app.name || appId;
                } catch (e) {
                  return app.name || appId;
                }
              };

              // Sort application IDs for consistent display
              const sortedAppIds = Object.keys(grouped).sort();

              return sortedAppIds.map((appId) => {
                const appContexts = grouped[appId];
                const alias = getAppAlias(appId);
                
                return (
                  <div key={appId} className="context-group">
                    <div className="context-group-header">
                      <h2>{alias}</h2>
                      <span className="context-count">({appContexts.length} {appContexts.length === 1 ? 'context' : 'contexts'})</span>
                    </div>
                    <div className="contexts-grid">
                      {appContexts.map((context, index) => (
                        <div key={context.id} className="context-card">
                          <div className="context-card-header">
                            <h3>{context.name || `Context ${index + 1}`}</h3>
                          </div>
                          <div className="context-card-body">
                            <p className="context-id">ID: {context.id}</p>
                            {(context.rootHash || context.root_hash) && (
                              <p className="context-root-hash">
                                Root Hash: {context.rootHash || context.root_hash}
                              </p>
                            )}
                            {context.description && (
                              <p className="context-description">{context.description}</p>
                            )}
                            {context.createdAt && (
                              <p className="context-date">Created: {new Date(context.createdAt).toLocaleString()}</p>
                            )}
                            {context.metadata && Object.keys(context.metadata).length > 0 && (
                              <div className="context-metadata">
                                <strong>Metadata:</strong>
                                <pre>{JSON.stringify(context.metadata, null, 2)}</pre>
                              </div>
                            )}
                          </div>
                          <div className="context-card-actions">
                            <button
                              onClick={() => openFrontend(context.id, context.applicationId || context.application_id || appId)}
                              className="button button-primary"
                              title="Open frontend with this context"
                            >
                              🚀 Open Frontend
                            </button>
                            <button
                              onClick={() => handleDeleteContext(context.id, context.name || `Context ${index + 1}`)}
                              className="button button-danger"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </main>
    </div>
  );
};

export default Contexts;

