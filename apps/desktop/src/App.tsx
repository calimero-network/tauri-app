import { useState, useEffect, useCallback } from "react";
import { createClient, apiClient, LoginView, getAccessToken } from "@calimero-network/mero-react";
import { getSettings, getAuthUrl, saveSettings } from "./utils/settings";
import { invoke } from "@tauri-apps/api/tauri";
import { checkOnboardingState, type OnboardingState } from "./utils/onboarding";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import Marketplace from "./pages/Marketplace";
import InstalledApps from "./pages/InstalledApps";
import Contexts from "./pages/Contexts";
import NodeManagement from "./pages/NodeManagement";
import ConfirmAction from "./pages/ConfirmAction";
import UpdateNotification from "./components/UpdateNotification";
import Sidebar from "./components/Sidebar";
import ToastContainer from "./components/ToastContainer";
import { getCurrentVersion } from "./utils/updater";
import { Settings as SettingsIcon, ArrowRight, Package, ShoppingCart } from "lucide-react";
import "./App.css";

function App() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [currentPage, setCurrentPage] = useState<'home' | 'marketplace' | 'installed' | 'contexts' | 'nodes' | 'confirm'>('home');
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);
  const [needsNodeConfig, setNeedsNodeConfig] = useState(false);
  const [installedApps, setInstalledApps] = useState<any[]>([]);
  const [loadingApps, setLoadingApps] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    itemName: string;
    actionLabel: string;
    onConfirm: () => void;
    breadcrumbs: Array<{ label: string; onClick?: () => void }>;
  } | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  // Load app version
  useEffect(() => {
    getCurrentVersion().then(setAppVersion);
  }, []);

  // Load installed apps for main page
  const loadInstalledApps = useCallback(async () => {
    setLoadingApps(true);
    try {
      const response = await apiClient.node.listApplications();
      if (response.error) {
        // If 401, show login (but not if we just completed onboarding)
        if (response.error.code === '401' && !showOnboarding) {
          setShowLogin(true);
          return;
        }
        console.error('❌ Apps error:', response.error.message);
        return;
      }
      if (response.data && Array.isArray(response.data)) {
        setInstalledApps(response.data);
      }
    } catch (err: any) {
      console.error('Failed to load apps:', err);
    } finally {
      setLoadingApps(false);
    }
  }, [showOnboarding]);

  // Load contexts for main page (only if developer mode)
  const loadContexts = useCallback(async () => {
    const settings = getSettings();
    if (!settings.developerMode) {
      return; // Skip loading contexts if developer mode is off
    }
    try {
      const contextsResponse = await apiClient.node.getContexts();
      if (contextsResponse.error) {
        // If 401, show login (but not if we just completed onboarding)
        if (contextsResponse.error.code === '401' && !showOnboarding) {
          setShowLogin(true);
          return;
        }
        console.error('❌ Contexts error:', contextsResponse.error.message);
        return;
      }
      // Contexts loaded (stored in API client state)
    } catch (err: any) {
      // Check for 401 in error object (but not if we just completed onboarding)
      if (err?.status === 401 && !showOnboarding) {
        setShowLogin(true);
        return;
      }
      console.error('Failed to load contexts:', err);
    }
  }, [showOnboarding]);

  useEffect(() => {
    async function initializeApp() {
      // Check if settings have been saved (user has completed setup)
      const hasCustomSettings = localStorage.getItem('calimero-desktop-settings') !== null;
      
      // If no settings saved, show onboarding immediately
      if (!hasCustomSettings) {
        console.log('📋 No settings found - showing onboarding immediately');
        setNeedsNodeConfig(true);
        setShowOnboarding(true);
        setCheckingOnboarding(false);
        return;
      }
      
      // Load settings on startup
      const settings = getSettings();
      
      // Always check for nodes first
      console.log('🔍 Checking for existing nodes...');
      setCheckingOnboarding(true);
      
      try {
        const { listMerodNodes, detectRunningMerodNodes } = await import('./utils/merod');
        const defaultDataDir = settings.embeddedNodeDataDir || '~/.calimero';
        const existingNodes = await listMerodNodes(defaultDataDir);
        
        // Check if any nodes are running
        const runningNodes = await detectRunningMerodNodes();
        
        // If no nodes exist at all, show onboarding
        if (existingNodes.length === 0 && runningNodes.length === 0) {
          console.log('📋 No nodes found - showing onboarding');
          setNeedsNodeConfig(true);
          setShowOnboarding(true);
          setCheckingOnboarding(false);
          return;
        }
        
        // If nodes exist but none are running, show onboarding to start one
        if (existingNodes.length > 0 && runningNodes.length === 0) {
          console.log('📋 Nodes exist but none running - showing onboarding');
          setNeedsNodeConfig(true);
          setShowOnboarding(true);
          setCheckingOnboarding(false);
          return;
        }
        
        // If we have running nodes, use the first one
        if (runningNodes.length > 0) {
          const node = runningNodes[0];
          const nodeUrl = `http://localhost:${node.port}`;
          
          // Update settings if needed
          if (!settings.nodeUrl || settings.nodeUrl !== nodeUrl) {
            saveSettings({ ...settings, nodeUrl });
            // Reload to continue with normal flow
            window.location.reload();
            return;
          }
        }
        
        // We have a node URL configured - continue with normal initialization
        console.log('✅ Node URL configured, continuing with normal flow');
      } catch (error) {
        console.error('Failed to check for existing nodes:', error);
        // On error, show onboarding
        setNeedsNodeConfig(true);
        setShowOnboarding(true);
        setCheckingOnboarding(false);
        return;
      }
      
      const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
      const authUrl = getAuthUrl(settings);
      const authBaseUrl = authUrl.replace(/\/$/, '');

      // Initialize mero-react client
      createClient({
        baseUrl: adminApiUrl,
        authBaseUrl: authBaseUrl,
        requestCredentials: 'omit',
      });

      // First, quickly check if the node is running at the configured URL
      setCheckingOnboarding(true);
      console.log('🔍 Checking if node is running at:', settings.nodeUrl);
      
      try {
        // Quick health check with short timeout (3 seconds)
        const healthCheck = await Promise.race([
          apiClient.node.healthCheck(),
          new Promise<{ error: { message: string; code?: string } }>((resolve) =>
            setTimeout(() => resolve({ error: { message: 'Node not responding' } }), 3000)
          ),
        ]);

        if (healthCheck.error) {
          // Node is not running - show onboarding to configure/start node
          console.log('⚠️ Node not running or not accessible, showing onboarding');
          setCheckingOnboarding(false);
          setNeedsNodeConfig(true);
          setShowOnboarding(true);
          return;
        }

        // Node is running - clear needsNodeConfig since we have a working node
        setNeedsNodeConfig(false);
        
        // Proceed with onboarding/auth checks
        console.log('✅ Node is running, checking onboarding state...');
        const onboardingState = await Promise.race([
          checkOnboardingState(),
          new Promise<OnboardingState>((resolve) =>
            setTimeout(() => {
              resolve({
                isFirstTime: false,
                authAvailable: false,
                providersAvailable: false,
                providersConfigured: false,
                hasConfiguredProviders: false,
                error: 'Connection timeout. Please check if the node is running at ' + settings.nodeUrl,
              });
            }, 10000)
          ),
        ]);
        // Onboarding state checked

        // Debug logging
        console.log('🔍 Onboarding State:', {
          isFirstTime: onboardingState.isFirstTime,
          authAvailable: onboardingState.authAvailable,
          providersAvailable: onboardingState.providersAvailable,
          hasConfiguredProviders: onboardingState.hasConfiguredProviders,
          error: onboardingState.error,
        });

        // Flow logic:
        // 1. If auth is NOT configured (no users) → Onboarding (first time, create account)
        // 2. If auth IS configured (has users) → Check if logged in
        //    - Not logged in → Login screen
        //    - Logged in → Main app
        // 3. If auth service unavailable → Show error in onboarding
        
        if (!onboardingState.authAvailable) {
          // Auth service not available - show onboarding with error
          // But don't redirect back to Nodes page if node is running
          console.log('⚠️ Auth service not available, showing onboarding with error');
          setNeedsNodeConfig(false); // Clear needsNodeConfig since node is running
          setShowOnboarding(true);
        } else if (!onboardingState.hasConfiguredProviders) {
          // Auth available but no users configured - show onboarding (first time)
          console.log('📋 No users configured, showing onboarding screen');
          setShowOnboarding(true);
        } else {
          // Auth is configured (has users) - check if user is logged in
          const hasToken = getAccessToken();
          console.log('🔑 Token check:', hasToken ? 'EXISTS' : 'NONE');
          if (!hasToken) {
            console.log('🔐 Showing login screen');
            setShowLogin(true);
          } else {
            // User has token, try to load contexts and apps
            console.log('✅ User logged in, loading contexts and apps');
            loadContexts();
            loadInstalledApps();
          }
        }
      } catch (err) {
        console.error('Failed to check node connection:', err);
        // On error, show onboarding to allow configuration
        setCheckingOnboarding(false);
        setNeedsNodeConfig(true);
        setShowOnboarding(true);
        return;
      } finally {
        setCheckingOnboarding(false);
      }
    }

    initializeApp();
  }, [loadContexts]);

  const checkConnection = useCallback(async () => {
    try {
      setError(null);
      
      // Check health endpoint (admin API)
      const healthResponse = await apiClient.node.healthCheck();
      if (healthResponse.error) {
        // If 401, show login
        if (healthResponse.error.code === '401') {
          setShowLogin(true);
          setConnected(false);
          return;
        }
        setError(healthResponse.error.message);
        setConnected(false);
        return;
      }
      
      setConnected(true);
      setError(null);

      // Load contexts and apps after successful connection
        await loadContexts();
      await loadInstalledApps();
    } catch (err) {
      setConnected(false);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      console.error("Connection error:", err);
    }
  }, [loadContexts, loadInstalledApps]);

  // Helper function to decode app metadata
  const decodeMetadata = useCallback((metadata: any): any => {
    if (!metadata) return null;
    try {
      let jsonString: string;
      if (typeof metadata === 'string') {
        jsonString = atob(metadata);
      } else if (Array.isArray(metadata)) {
        jsonString = String.fromCharCode(...metadata);
      } else {
        return metadata;
      }
      return JSON.parse(jsonString);
    } catch (error) {
      console.warn("Failed to decode metadata:", error);
      return null;
      }
  }, []);

  // Open app frontend in a new window
  const handleOpenAppFrontend = useCallback(async (frontendUrl: string, appName?: string) => {
    try {
      const settings = getSettings();
      const urlObj = new URL(frontendUrl);
      const domain = urlObj.hostname.replace(/\./g, '-');
      const windowLabel = `app-${domain}-${Date.now()}`;
      await invoke('create_app_window', {
        windowLabel,
        url: frontendUrl,
        title: appName || 'Application',
        openDevtools: false,
        nodeUrl: settings.nodeUrl,
      });
      console.log('Opened app frontend in new window:', frontendUrl);
    } catch (error) {
      console.error("Failed to open frontend:", error);
      // Fallback to navigating to installed apps page
      setCurrentPage('installed');
    }
  }, []);

  // Auto-check node status every 5 seconds when on home page
  useEffect(() => {
    // Only run on home page
    if (currentPage !== 'home') {
      return;
    }

    // Initial check
    checkConnection();

    // Set up interval to check every 5 seconds
    const interval = setInterval(() => {
      checkConnection();
    }, 5000);

    // Cleanup interval on unmount or page change
    return () => {
      clearInterval(interval);
    };
  }, [currentPage, checkConnection]); // Re-run when page changes or checkConnection changes

  // Show onboarding if needed
  if (checkingOnboarding) {
    return (
      <div className="app">
        <div className="loading-screen">
          <div className="loading-spinner-large"></div>
          <h2>Setting up Calimero Desktop</h2>
          <p>Checking your node connection and configuration...</p>
        </div>
      </div>
    );
  }

  // Calculate page title and sidebar page before early returns
  const sidebarPage: 'home' | 'marketplace' | 'installed' | 'contexts' | 'nodes' = 
    currentPage === 'confirm' ? 'home' : currentPage;

  let pageTitle: string;
  switch (currentPage) {
    case 'home':
      pageTitle = 'Home';
      break;
    case 'nodes':
      pageTitle = 'Nodes';
      break;
    case 'contexts':
      pageTitle = 'Contexts';
      break;
    case 'installed':
      pageTitle = 'Applications';
      break;
    case 'marketplace':
      pageTitle = 'Marketplace';
      break;
    case 'confirm':
      pageTitle = 'Confirm Action';
      break;
    default:
      pageTitle = 'Home';
  }

  if (showOnboarding) {
    return (
      <Onboarding
        onComplete={() => {
          setShowOnboarding(false);
          // After onboarding, user is already logged in, just load data
          // Don't call checkConnection() as it might trigger login screen
          // Set connected to true since user just authenticated
          setConnected(true);
          setError(null);
          // Load data but don't show login on 401 errors since user just authenticated
          loadContexts().catch(() => {
            // Silently fail - user can retry later if needed
          });
          loadInstalledApps().catch(() => {
            // Silently fail - user can retry later if needed
          });
        }}
        onSettings={() => {
          setShowOnboarding(false);
          setShowSettings(true);
        }}
      />
    );
  }

  // Show login if needed
  if (showLogin) {
    return (
      <div className="app">
        <div style={{ position: 'absolute', top: '16px', right: '16px', display: 'flex', gap: '8px', zIndex: 1000 }}>
          <button 
            onClick={() => { 
              setShowLogin(false); 
              setShowSettings(true); 
            }} 
            className="button" 
            style={{ background: '#f0f0f0', padding: '8px 16px' }}
          >
            <SettingsIcon size={16} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
            Settings
          </button>
        </div>
        <LoginView
          onSuccess={() => {
            console.log('✅ Login successful');
            setShowLogin(false);
            // Reload contexts after login
            loadContexts();
            loadInstalledApps();
            checkConnection();
          }}
          onError={(error) => {
            console.error('❌ Login failed:', error);
          }}
        />
      </div>
    );
  }


  if (showSettings) {
    return (
      <Settings
        onBack={async () => {
          setShowSettings(false);
          
          // Always reload client when returning from Settings (settings may have changed)
          const settings = getSettings();
          const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
          const authUrl = getAuthUrl(settings);
          const authBaseUrl = authUrl.replace(/\/$/, '');

          // Reload client with new settings
          createClient({
            baseUrl: adminApiUrl,
            authBaseUrl: authBaseUrl,
            requestCredentials: 'omit',
          });
          
          if (needsNodeConfig) {
            // After first-time settings, continue with app initialization
            setNeedsNodeConfig(false);

            // Check onboarding state
            setCheckingOnboarding(true);
            try {
              const state = await checkOnboardingState();
              // Onboarding state checked

              // Determine what to show
              if (!state.authAvailable) {
                setShowOnboarding(true);
              } else if (!state.hasConfiguredProviders) {
                setShowOnboarding(true);
              } else {
                const hasToken = getAccessToken();
                if (!hasToken) {
                  setShowLogin(true);
                } else {
                  loadContexts();
            loadInstalledApps();
                }
              }
            } catch (err) {
              console.error('Failed to check onboarding state:', err);
              setShowOnboarding(true);
            } finally {
              setCheckingOnboarding(false);
            }
          } else {
            // Settings changed, reload contexts if logged in
            const hasToken = getAccessToken();
            if (hasToken) {
              loadContexts();
            loadInstalledApps();
            }
          }
        }}
      />
    );
  }

  // Show Marketplace if selected
  if (currentPage === 'marketplace') {
    return (
      <div className="app">
        <div className="app-layout">
          <Sidebar 
            currentPage={currentPage} 
            onNavigate={setCurrentPage}
            onOpenSettings={() => setShowSettings(true)}
          />
          <div className="app-content">
        <header className="header">
              <div className="header-title">
                <h1>Marketplace</h1>
              </div>
            </header>
            <main className="main">
              <Marketplace />
            </main>
          </div>
        </div>
      </div>
    );
  }

  // Show Installed Apps if selected
  if (currentPage === 'installed') {
    return (
      <div className="app">
        <div className="app-layout">
          <Sidebar 
            currentPage={currentPage} 
            onNavigate={setCurrentPage}
            onOpenSettings={() => setShowSettings(true)}
          />
          <div className="app-content">
        <header className="header">
              <div className="header-title">
                <h1>Applications</h1>
          </div>
        </header>
            <main className="main">
        <InstalledApps 
          onAuthRequired={() => setShowLogin(true)}
          onConfirmUninstall={(_appId, appName, onConfirm) => {
            setConfirmAction({
              title: "Uninstall Application",
              message: "Are you sure you want to uninstall this application? This action cannot be undone.",
              itemName: appName,
              actionLabel: "Uninstall",
              onConfirm: async () => {
                await onConfirm();
                setCurrentPage('installed');
                setConfirmAction(null);
              },
              breadcrumbs: [
                { label: "Home", onClick: () => setCurrentPage('home') },
                { label: "Applications", onClick: () => setCurrentPage('installed') },
                { label: "Uninstall Application" },
              ],
            });
            setCurrentPage('confirm');
          }}
        />
            </main>
          </div>
        </div>
      </div>
    );
  }

  // Show Node Management if selected
  if (currentPage === 'nodes') {
    return (
      <div className="app">
        <div className="app-layout">
          <Sidebar 
            currentPage="nodes" 
            onNavigate={(p) => {
              if (p === 'nodes') setCurrentPage('nodes');
              else if (p === 'contexts') setCurrentPage('contexts');
              else if (p === 'marketplace') setCurrentPage('marketplace');
              else if (p === 'installed') setCurrentPage('installed');
              else if (p === 'home') setCurrentPage('home');
            }}
            onOpenSettings={() => setShowSettings(true)}
          />
          <div className="app-content">
            <header className="header">
              <div className="header-title">
                <h1>Nodes</h1>
              </div>
            </header>
            <main className="main">
              <NodeManagement />
            </main>
          </div>
        </div>
      </div>
    );
  }

  // Show Contexts if selected
  if (currentPage === 'contexts') {
    return (
      <div className="app">
        <div className="app-layout">
          <Sidebar 
            currentPage={currentPage} 
            onNavigate={setCurrentPage}
            onOpenSettings={() => setShowSettings(true)}
          />
          <div className="app-content">
        <header className="header">
              <div className="header-title">
            <h1>Contexts</h1>
          </div>
        </header>
            <main className="main">
        <Contexts 
          onAuthRequired={() => setShowLogin(true)}
          onConfirmDelete={(_contextId, contextName, onConfirm) => {
            setConfirmAction({
              title: "Delete Context",
              message: "Are you sure you want to delete this context? This action cannot be undone.",
              itemName: contextName,
              actionLabel: "Delete",
              onConfirm: async () => {
                await onConfirm();
                setCurrentPage('contexts');
                setConfirmAction(null);
              },
              breadcrumbs: [
                { label: "Home", onClick: () => setCurrentPage('home') },
                { label: "Contexts", onClick: () => setCurrentPage('contexts') },
                { label: "Delete Context" },
              ],
            });
            setCurrentPage('confirm');
          }}
        />
            </main>
          </div>
        </div>
      </div>
    );
  }

  // Show confirmation page
  if (currentPage === 'confirm' && confirmAction) {
    return (
      <div className="app">
        <ConfirmAction
          title={confirmAction.title}
          message={confirmAction.message}
          itemName={confirmAction.itemName}
          actionLabel={confirmAction.actionLabel}
          onConfirm={confirmAction.onConfirm}
          onCancel={() => {
            // Go back to the previous page (contexts or installed)
            if (confirmAction.breadcrumbs[1]?.onClick) {
              confirmAction.breadcrumbs[1].onClick();
            } else {
              setCurrentPage('home');
            }
            setConfirmAction(null);
          }}
          breadcrumbs={confirmAction.breadcrumbs}
        />
      </div>
    );
  }


  return (
    <div className="app">
      {/* Toast notifications */}
      <ToastContainer />
      
      {/* Auto-update notification */}
      <UpdateNotification checkOnMount={true} checkInterval={3600000} />

      <div className="app-layout">
        <Sidebar 
          currentPage={sidebarPage} 
          onNavigate={(p) => {
            if (p === 'nodes') setCurrentPage('nodes');
            else if (p === 'contexts') setCurrentPage('contexts');
            else if (p === 'marketplace') setCurrentPage('marketplace');
            else if (p === 'installed') setCurrentPage('installed');
            else if (p === 'home') setCurrentPage('home');
          }}
          onOpenSettings={() => setShowSettings(true)}
        />
        
        <div className="app-content">
      <header className="header">
            <div className="header-title">
              <h1>{pageTitle}</h1>
          {appVersion && (
                <span className="version-badge">v{appVersion}</span>
          )}
        </div>
      </header>

      <main className="main">
        {/* Welcome Section */}
        <div className="welcome-section">
          <h2>Welcome to Calimero Desktop</h2>
          <p className="welcome-description">
            Your gateway to decentralized applications. Get started by installing apps from the marketplace.
          </p>
        </div>

        {/* Node Status - Simplified */}
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
              <p className="status-error">{error}</p>
            )}
          </div>
          </div>

        {/* Recent Applications */}
        {installedApps.length > 0 && (
          <div className="recent-apps-section">
            <div className="section-header">
              <h3>Your Applications</h3>
              <button 
                onClick={() => setCurrentPage('installed')} 
                className="view-all-link"
              >
                View All
                <ArrowRight size={14} />
          </button>
            </div>
            <div className="apps-grid">
              {installedApps.slice(0, 4).map((app: any) => {
                let appName = app.id;
                let frontendUrl: string | null = null;
                try {
                  const metadata = decodeMetadata(app.metadata);
                  if (metadata) {
                    appName = metadata.name || metadata.alias || app.id;
                    frontendUrl = metadata?.links?.frontend || null;
                  }
                } catch (e) {
                  // Use app.id as fallback
                }
                
                return (
                  <button
                    key={app.id}
                    onClick={() => {
                      if (frontendUrl) {
                        handleOpenAppFrontend(frontendUrl, appName);
                      } else {
                        setCurrentPage('installed');
                      }
                    }}
                    className="app-card-mini"
                    title={frontendUrl ? `Open ${appName}` : `View ${appName} details`}
                  >
                    <Package className="app-icon" size={20} />
                    <span className="app-name">{appName}</span>
                  </button>
                );
              })}
            </div>
            </div>
          )}

        {/* Empty State for Apps */}
        {!loadingApps && installedApps.length === 0 && (
          <div className="empty-state-card">
            <Package size={48} className="empty-icon" />
            <h3>No Applications Installed</h3>
            <p>Get started by browsing the marketplace and installing your first app.</p>
            <button 
              onClick={() => setCurrentPage('marketplace')} 
              className="button button-primary"
            >
              <ShoppingCart size={16} />
              Browse Marketplace
            </button>
          </div>
        )}

        {/* Quick Actions */}
        <div className="quick-actions">
          <h3>Quick Actions</h3>
          <div className="actions-grid">
            <button 
              onClick={() => setCurrentPage('marketplace')} 
              className="action-card"
            >
              <ShoppingCart className="action-icon" size={24} />
              <div>
                <strong>Browse Marketplace</strong>
                <p>Discover and install new applications</p>
              </div>
          </button>
            {installedApps.length > 0 && (
              <button 
                onClick={() => setCurrentPage('installed')} 
                className="action-card"
              >
                <Package className="action-icon" size={24} />
                <div>
                  <strong>Applications</strong>
                  <p>View and manage your applications</p>
            </div>
              </button>
            )}
            <button 
              onClick={() => setShowSettings(true)}
              className="action-card"
            >
              <SettingsIcon className="action-icon" size={24} />
              <div>
                <strong>Settings</strong>
                <p>Configure node, theme, and app settings</p>
              </div>
            </button>
          </div>
        </div>

      </main>
        </div>
      </div>
    </div>
  );
}

export default App;

