import React, { useState, useEffect } from "react";
import { apiClient } from "@calimero-network/mero-react";
import { invoke } from "@tauri-apps/api/tauri";
import "./InstalledApps.css";

interface InstalledApplication {
  id: string;
  name?: string;
  version?: string;
  metadata: number[] | string; // Can be array of bytes or base64 string
  blob?: {
    bytecode: string;
    compiled: string;
  };
  size?: number;
  source?: string;
}

export interface InstalledAppsProps {
  onAuthRequired?: () => void;
  onConfirmUninstall?: (appId: string, appName: string, onConfirm: () => Promise<void>) => void;
  clientReady?: boolean;
}

const InstalledApps: React.FC<InstalledAppsProps> = ({ onAuthRequired, onConfirmUninstall, clientReady = true }) => {
  const [apps, setApps] = useState<InstalledApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (clientReady) {
      loadInstalledApps();
    }
  }, [clientReady]);

  const loadInstalledApps = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.node.listApplications();
      console.log("📦 listApplications response:", JSON.stringify(response, null, 2));
      
      if (response.error) {
        // If 401, trigger login redirect
        if (response.error.code === '401') {
          console.warn("📦 InstalledApps: 401 Unauthorized - token may be expired");
          onAuthRequired?.();
          return;
        }
        setError(response.error.message);
        setApps([]);
        return;
      }

      if (response.data) {
        // The client now returns { data: apps[] } where apps is already extracted
        const appsList = Array.isArray(response.data) 
          ? response.data 
          : [];
        console.log("📦 Apps list:", appsList);
        setApps(appsList);
      } else {
        console.warn("📦 No data in response");
        setApps([]);
      }
    } catch (err: any) {
      // Check for 401 in error object
      if (err?.status === 401 || err?.code === '401') {
        console.warn("📦 InstalledApps: 401 Unauthorized - triggering login");
        onAuthRequired?.();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load installed applications");
      console.error("Failed to load installed apps:", err);
      setApps([]);
    } finally {
      setLoading(false);
    }
  };

  const handleUninstall = async (appId: string, appName: string) => {
    if (onConfirmUninstall) {
      onConfirmUninstall(appId, appName, async () => {
        try {
          const response = await apiClient.node.uninstallApplication(appId);
          if (response.error) {
            alert(`Failed to uninstall: ${response.error.message}`);
            return;
          }

          alert(`Application "${appName}" uninstalled successfully`);
          // Reload the list
          await loadInstalledApps();
        } catch (err) {
          alert(`Failed to uninstall application: ${err instanceof Error ? err.message : "Unknown error"}`);
          console.error("Uninstall error:", err);
        }
      });
    } else {
      // Fallback if onConfirmUninstall is not provided
      try {
        const response = await apiClient.node.uninstallApplication(appId);
        if (response.error) {
          alert(`Failed to uninstall: ${response.error.message}`);
          return;
        }

        alert(`Application "${appName}" uninstalled successfully`);
        await loadInstalledApps();
      } catch (err) {
        alert(`Failed to uninstall application: ${err instanceof Error ? err.message : "Unknown error"}`);
        console.error("Uninstall error:", err);
      }
    }
  };

  const decodeMetadata = (metadata: number[] | string): any => {
    try {
      let jsonString: string;
      
      if (Array.isArray(metadata)) {
        // Convert array of bytes to string
        jsonString = String.fromCharCode(...metadata);
      } else {
        // Assume it's base64 encoded string
        jsonString = atob(metadata);
      }
      
      return JSON.parse(jsonString);
    } catch (error) {
      console.warn("Failed to decode metadata:", error);
      return null;
    }
  };

  const handleOpenFrontend = async (frontendUrl: string, appName?: string) => {
    try {
      // Get configured node URL from settings for HTTP interception
      const { getSettings } = await import('../utils/settings');
      const settings = getSettings();
      
      // Always open in a new Tauri window
      // Use unique window label based on domain + timestamp to avoid conflicts
      // IPC scope uses wildcard pattern (app-*) so any label matching app-* will work
      const urlObj = new URL(frontendUrl);
      const domain = urlObj.hostname.replace(/\./g, '-'); // Replace dots with dashes for label
      const windowLabel = `app-${domain}-${Date.now()}`;
      await invoke('create_app_window', {
        windowLabel,
        url: frontendUrl,
        title: appName || 'Application',
        nodeUrl: settings.nodeUrl,
      });
      console.log('Opened in new Tauri window:', frontendUrl, 'with label:', windowLabel);
    } catch (error) {
      console.error("Failed to open frontend:", error);
      alert(`Failed to open frontend: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  return (
    <div className="installed-apps-page">
      <header className="installed-apps-header">
        <h1>Installed Applications</h1>
        <button onClick={loadInstalledApps} className="button" disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </header>

      <main className="installed-apps-main">
        {error && (
          <div className="error-message">
            {error}
          </div>
        )}

        {loading ? (
          <div className="loading">Loading applications...</div>
        ) : apps.length === 0 ? (
          <div className="empty-state">
            <p>No applications installed.</p>
            <p>Visit the <a href="#marketplace">Marketplace</a> to install applications.</p>
          </div>
        ) : (
          <div className="apps-grid">
            {apps.map((app) => {
              const metadata = decodeMetadata(app.metadata);
              const appName = metadata?.name || app.name || app.id;
              const appVersion = metadata?.version || app.version || "Unknown";
              // Get frontend URL from bundle metadata (no fallback - must be in metadata)
              const frontendUrl = metadata?.links?.frontend;
              
              return (
                <div key={app.id} className="app-card">
                  <div className="app-card-header">
                    <h3>{appName}</h3>
                  </div>
                  <div className="app-card-body">
                    <p className="app-id">ID: {app.id}</p>
                    <p className="app-version">Version: {appVersion}</p>
                    {app.size && (
                      <p className="app-size">Size: {(app.size / 1024).toFixed(2)} KB</p>
                    )}
                    {app.source && (
                      <p className="app-source">Source: {app.source}</p>
                    )}
                    {metadata?.description && (
                      <p className="app-description">{metadata.description}</p>
                    )}
                    {metadata?.developer && (
                      <p className="app-developer">
                        Developer: {metadata.developer.substring(0, 16)}...
                      </p>
                    )}
                    {app.blob && (
                      <p className="app-blob">
                        Bytecode: {app.blob.bytecode.substring(0, 16)}...
                      </p>
                    )}
                  </div>
                  <div className="app-card-actions">
                    {frontendUrl && (
                      <button
                        onClick={() => handleOpenFrontend(frontendUrl, appName)}
                        className="button button-primary"
                        title={`Open ${appName} frontend`}
                      >
                        Open Frontend
                      </button>
                    )}
                    <button
                      onClick={() => handleUninstall(app.id, appName)}
                      className="button button-danger"
                    >
                      Uninstall
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
};

export default InstalledApps;

