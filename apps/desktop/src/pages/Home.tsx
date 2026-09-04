import { useCallback, useEffect, useState, memo } from "react";
import { decodeMetadata, openAppFrontend } from "../utils/appUtils";
import { listInstalledApps } from "../utils/installedAppsCache";
import { Settings as SettingsIcon, ArrowRight, Package, ShoppingCart } from "lucide-react";

interface HomeProps {
  connected: boolean;
  error: string | null;
  clientReady: boolean;
  onReconnect: () => void;
  onNavigate: (page: 'installed' | 'marketplace') => void;
  onOpenSettings: () => void;
  onAuthRequired: () => void;
}

function Home({ connected, error, clientReady, onReconnect, onNavigate, onOpenSettings, onAuthRequired }: HomeProps) {
  const [installedApps, setInstalledApps] = useState<any[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);

  useEffect(() => {
    // Until the client is configured, the singleton falls back to its hardcoded
    // localhost:2528, so a node on any other port answers 401 and forces login.
    if (!clientReady) return;
    setLoadingApps(true);
    listInstalledApps()
      .then((response) => {
        if (response.error) {
          if (response.error.code === '401') {
            onAuthRequired();
            return;
          }
          console.error('❌ Apps error:', response.error.message);
          return;
        }
        if (response.data && Array.isArray(response.data)) {
          setInstalledApps(response.data);
        }
      })
      .catch((err) => console.error('Failed to load apps:', err))
      .finally(() => setLoadingApps(false));
  }, [clientReady, onAuthRequired]);

  const handleOpenAppFrontend = useCallback(async (frontendUrl: string, appName?: string, applicationId?: string, iconData?: string) => {
    try {
      await openAppFrontend(frontendUrl, appName, undefined, applicationId ? { applicationId, iconData } : undefined);
    } catch {
      onNavigate('installed');
    }
  }, [onNavigate]);

  return (
    <>
      <div className="welcome-section">
        <h2>Welcome to Calimero Desktop</h2>
        <p className="welcome-description">
          Your gateway to decentralized applications. Get started by installing apps from the marketplace.
        </p>
      </div>

      <div className="status-cards-simple">
        <div className="status-card-simple">
          <div className="status-header-simple">
            <h3>Node Status</h3>
            <div className={`status-badge ${connected ? "connected" : "disconnected"}`}>
              <div className="status-dot"></div>
              {connected ? "Connected" : "Disconnected"}
            </div>
          </div>
          {!connected && error && (
            <div className="status-error-block">
              <p className="status-error">{error}</p>
              <p className="status-error-hint">
                Can't reach your node right now (e.g. after your computer slept). Click Reconnect to check its status again.
              </p>
              <button onClick={onReconnect} className="button button-primary button-small">
                Reconnect
              </button>
            </div>
          )}
        </div>
      </div>

      {installedApps.length > 0 && (
        <div className="recent-apps-section">
          <div className="section-header">
            <h3>Your Applications</h3>
            <button onClick={() => onNavigate('installed')} className="view-all-link">
              View All
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="apps-grid">
            {installedApps.slice(0, 4).map((app: any, index: number) => {
              let appName = app.id;
              let frontendUrl: string | null = null;
              let iconData: string | undefined;
              try {
                const metadata = decodeMetadata(app.metadata);
                if (metadata) {
                  appName = metadata.name || metadata.alias || app.id;
                  frontendUrl = metadata?.links?.frontend || null;
                  iconData = metadata?.icon;
                }
              } catch {
                // Use app.id as fallback
              }

              return (
                <button
                  key={`${app?.id != null && String(app.id) !== '' ? String(app.id) : 'app'}-${index}`}
                  type="button"
                  onClick={() => {
                    if (frontendUrl) {
                      handleOpenAppFrontend(frontendUrl, appName, app.id, iconData);
                    } else {
                      onNavigate('installed');
                    }
                  }}
                  className="app-card-mini"
                  title={frontendUrl ? `Open ${appName}` : `View ${appName} details`}
                >
                  <Package className="app-icon" size={28} />
                  <span className="app-name">{appName}</span>
                  {frontendUrl && <span className="app-card-open-hint">Open</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!loadingApps && installedApps.length === 0 && (
        <div className="empty-state-card">
          <Package size={48} className="empty-icon" />
          <h3>No Applications Installed</h3>
          <p>Get started by browsing the marketplace and installing your first app.</p>
          <button onClick={() => onNavigate('marketplace')} className="btn-browse-marketplace">
            <ShoppingCart size={16} className="browse-icon" />
            Browse Marketplace
          </button>
        </div>
      )}

      <div className="quick-actions">
        <h3>Quick Actions</h3>
        <div className="actions-grid">
          <button onClick={() => onNavigate('marketplace')} className="action-card">
            <ShoppingCart className="action-icon" size={24} />
            <div>
              <strong>Browse Marketplace</strong>
              <p>Discover and install new applications</p>
            </div>
          </button>
          {installedApps.length > 0 && (
            <button onClick={() => onNavigate('installed')} className="action-card">
              <Package className="action-icon" size={24} />
              <div>
                <strong>Applications</strong>
                <p>View and manage your applications</p>
              </div>
            </button>
          )}
          <button onClick={onOpenSettings} className="action-card">
            <SettingsIcon className="action-icon" size={24} />
            <div>
              <strong>Settings</strong>
              <p>Configure node, theme, and app settings</p>
            </div>
          </button>
        </div>
      </div>
    </>
  );
}

export default memo(Home);
