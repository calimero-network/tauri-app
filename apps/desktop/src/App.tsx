import { useState, useEffect, useCallback } from "react";
import { createClient, apiClient, LoginView, getAccessToken } from "@calimero-network/mero-react";
import { getSettings, getAuthUrl, saveSettings } from "./utils/settings";
import { clearOnboardingProgress } from "./utils/onboardingProgress";
import { startMerod, detectRunningMerodNodes, type RunningMerodNode } from "./utils/merod";
import { useToast } from "./contexts/ToastContext";
import { checkOnboardingState, type OnboardingState } from "./utils/onboarding";
import { decodeMetadata, openAppFrontend } from "./utils/appUtils";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import Marketplace from "./pages/Marketplace";
import InstalledApps from "./pages/InstalledApps";
import Contexts from "./pages/Contexts";
import NodeManagement from "./pages/NodeManagement";
import ConfirmAction from "./pages/ConfirmAction";
import UpdateNotification from "./components/UpdateNotification";
import Sidebar from "./components/Sidebar";
import { NodeStatusIndicator } from "./components/NodeStatusIndicator";
import ToastContainer from "./components/ToastContainer";
import { getCurrentVersion } from "./utils/updater";
import { invoke } from "@tauri-apps/api/tauri";
import { Settings as SettingsIcon, ArrowRight, Package, ShoppingCart } from "lucide-react";
import calimeroLogo from "./assets/calimero-logo.svg";
import { useTheme } from "./contexts/ThemeContext";
import "./App.css";

function App() {
  const toast = useToast();
  const { theme } = useTheme();
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
  const [runningNodes, setRunningNodes] = useState<RunningMerodNode[]>([]);

  const handleSelectNode = useCallback((nodeUrl: string) => {
    const settings = getSettings();
    saveSettings({ ...settings, nodeUrl });
    window.location.reload();
  }, []);

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
      const hasCustomSettings = localStorage.getItem('calimero-desktop-settings') !== null;
      const settings = getSettings();
      let onboardingCompleted = settings.onboardingCompleted ?? false;

      // Migrate: existing users before onboardingCompleted existed - treat as completed if they have nodeUrl
      if (hasCustomSettings && settings.onboardingCompleted === undefined && settings.nodeUrl) {
        saveSettings({ ...settings, onboardingCompleted: true });
        onboardingCompleted = true;
      }

      // First-time install: no settings or never completed onboarding
      if (!hasCustomSettings || !onboardingCompleted) {
        if (!hasCustomSettings) {
          console.log('📋 No settings found - first install, showing onboarding');
        } else {
          console.log('📋 Onboarding not completed - showing onboarding');
        }
        setNeedsNodeConfig(true);
        setShowOnboarding(true);
        setCheckingOnboarding(false);
        return;
      }

      // Returning user - onboarding was completed. Never show onboarding again.
      // Initialize client and go to main app (with login if needed, disconnected if node down).
      console.log('✅ Returning user - onboarding completed, loading main app');
      setCheckingOnboarding(true);

      // One-time: enable start-at-login by default for existing users who didn't have it set
      if (!localStorage.getItem("calimero-autostart-default-applied")) {
        try {
          await invoke("autostart_enable");
          localStorage.setItem("calimero-autostart-default-applied", "1");
        } catch {
          // Autostart may not be available
        }
      }

      try {
        const { startMerod } = await import('./utils/merod');
        let runningNodes = await detectRunningMerodNodes();
        setRunningNodes(runningNodes);

        // Auto-start merod if user has embedded node configured and no node is running
        // (embeddedNodeName indicates they set up a node via our app; useEmbeddedNode may not be set)
        if (
          settings.embeddedNodeName &&
          runningNodes.length === 0
        ) {
          const dataDir = settings.embeddedNodeDataDir || '~/.calimero';
          const serverPort = settings.embeddedNodePort ?? 2528;
          const swarmPort = 2428; // default swarm port
          console.log('🔄 Auto-starting merod node (configured for startup)');
          try {
            await startMerod(serverPort, swarmPort, dataDir, settings.embeddedNodeName);
            await new Promise((r) => setTimeout(r, 4000)); // give merod time to start (longer when app launches at login)
            runningNodes = await detectRunningMerodNodes();
            setRunningNodes(runningNodes);
          } catch (startErr) {
            console.warn('Auto-start merod failed:', startErr);
          }
        }

        // Auto-update nodeUrl if we detect a running local node and user has localhost or no URL.
        // When developer mode + multiple nodes, skip auto-select so user can choose from dropdown.
        if (runningNodes.length > 0 && !(settings.developerMode && runningNodes.length > 1)) {
          const node = runningNodes[0];
          const nodeUrl = `http://localhost:${node.port}`;
          const currentUrl = settings.nodeUrl;
          const isLocalhostUrl = currentUrl && (
            currentUrl.startsWith('http://localhost:') ||
            currentUrl.startsWith('http://127.0.0.1:')
          );
          if ((!currentUrl || isLocalhostUrl) && currentUrl !== nodeUrl) {
            saveSettings({ ...settings, nodeUrl });
            window.location.reload();
            return;
          }
        }
      } catch (error) {
        console.error('Failed to check nodes:', error);
      }

      const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
      const authUrl = getAuthUrl(settings);
      const authBaseUrl = authUrl.replace(/\/$/, '');
      createClient({
        baseUrl: adminApiUrl,
        authBaseUrl: authBaseUrl,
        requestCredentials: 'omit',
      });

      try {
        const healthCheck = await Promise.race([
          apiClient.node.healthCheck(),
          new Promise<{ error: { message: string; code?: string } }>((resolve) =>
            setTimeout(() => resolve({ error: { message: 'Node not responding' } }), 3000)
          ),
        ]);

        if (healthCheck.error) {
          // Node down - show main app with disconnected indicator (user can click Open Nodes)
          console.log('⚠️ Node not running - showing main app with disconnected status');
          setConnected(false);
          setError(healthCheck.error.message);
          setNeedsNodeConfig(false);
          loadContexts().catch(() => {});
          loadInstalledApps().catch(() => {});
          setCheckingOnboarding(false);
          invoke("set_tray_icon_connected", { connected: false }).catch(() => {});
          return;
        }

        setConnected(true);
        invoke("set_tray_icon_connected", { connected: true }).catch(() => {});
        setError(null);
        setNeedsNodeConfig(false);

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
                error: 'Connection timeout.',
              });
            }, 10000)
          ),
        ]);

        if (!onboardingState.authAvailable || !onboardingState.hasConfiguredProviders) {
          // Auth not ready - show main app (user can use Nodes/Settings to fix)
          console.log('⚠️ Auth not configured - showing main app');
          loadContexts().catch(() => {});
          loadInstalledApps().catch(() => {});
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
        console.error('Failed to check node:', err);
        setConnected(false);
        setError(err instanceof Error ? err.message : String(err));
        loadContexts().catch(() => {});
        loadInstalledApps().catch(() => {});
        invoke("set_tray_icon_connected", { connected: false }).catch(() => {});
      } finally {
        setCheckingOnboarding(false);
      }
    }

    initializeApp();
  }, [loadContexts]);

  const updateTrayIcon = useCallback((connected: boolean) => {
    invoke("set_tray_icon_connected", { connected }).catch((err) => {
      console.warn("Failed to update tray icon:", err);
    });
  }, []);

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
          updateTrayIcon(false);
          return;
        }
        setError(healthResponse.error.message);
        setConnected(false);
        updateTrayIcon(false);
        return;
      }
      
      setConnected(true);
      setError(null);
      updateTrayIcon(true);

      // Load contexts and apps after successful connection
        await loadContexts();
      await loadInstalledApps();
    } catch (err) {
      setConnected(false);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      console.error("Connection error:", err);
      updateTrayIcon(false);
    }
  }, [loadContexts, loadInstalledApps, updateTrayIcon]);

  const handleRestartNode = useCallback(async () => {
    const settings = getSettings();
    if (settings.embeddedNodeName) {
      try {
        const dataDir = settings.embeddedNodeDataDir || '~/.calimero';
        const serverPort = settings.embeddedNodePort ?? 2528;
        await startMerod(serverPort, 2428, dataDir, settings.embeddedNodeName);
        toast.success("Starting node...");
        await new Promise((r) => setTimeout(r, 3000));
        await checkConnection();
      } catch (err) {
        toast.error(`Failed to start node: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      setCurrentPage('nodes');
    }
  }, [checkConnection, toast]);

  // Open app frontend in a new window
  const handleOpenAppFrontend = useCallback(async (frontendUrl: string, appName?: string) => {
    try {
      await openAppFrontend(frontendUrl, appName);
    } catch (error) {
      // Fallback to navigating to installed apps page
      setCurrentPage('installed');
    }
  }, []);

  const handleCreateDesktopShortcut = useCallback(async (appName: string, frontendUrl: string) => {
    try {
      await invoke("create_desktop_shortcut", { appName, frontendUrl });
      toast.success("Desktop shortcut created on your Desktop");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create desktop shortcut");
    }
  }, [toast]);

  // Auto-check node status every 5 seconds (runs on all main app pages for global indicator)
  // Skip when on login or settings - those screens don't need the periodic check, and it would
  // redirect back to login on 401 while user is intentionally on Settings (e.g. to configure node)
  useEffect(() => {
    if (showLogin || showSettings) return;

    // Initial check
    checkConnection();

    // Set up interval to check every 5 seconds
    const interval = setInterval(() => {
      checkConnection();
    }, 5000);

    // Cleanup interval on unmount
    return () => clearInterval(interval);
  }, [checkConnection, showLogin, showSettings]);

  // When launched from a desktop shortcut (--open-app-url / --open-app-name): open app, focus it, then hide main window
  useEffect(() => {
    if (checkingOnboarding) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const pending = await invoke<[string, string] | null>("get_pending_open_app");
        if (cancelled || !pending) return;
        const [url, name] = pending;
        const windowLabel = await openAppFrontend(url, name);
        if (windowLabel) {
          await invoke("focus_window", { windowLabel });
        }
        await invoke("hide_main_window");
        await invoke("clear_pending_open_app");
      } catch (e) {
        console.warn("Failed to open app from shortcut:", e);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [checkingOnboarding]);

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
        onComplete={async () => {
          clearOnboardingProgress();
          const settings = getSettings();
          saveSettings({ ...settings, onboardingCompleted: true });
          try {
            await invoke("autostart_enable");
            localStorage.setItem("calimero-autostart-default-applied", "1");
          } catch {
            // Autostart may not be available
          }
          setShowOnboarding(false);
          setConnected(true);
          setError(null);
          loadContexts().catch(() => {});
          loadInstalledApps().catch(() => {});
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
      <div className="app login-screen">
        <header className="login-screen-header">
          <div className="login-screen-brand">
            <img src={calimeroLogo} alt="Calimero" className="login-screen-logo" />
          </div>
          <button 
            onClick={() => { 
              setShowLogin(false); 
              setShowSettings(true); 
            }} 
            className="button button-secondary"
          >
            <SettingsIcon size={16} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
            Settings
          </button>
        </header>
        <main className="login-screen-main">
        <LoginView
          variant={theme}
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
        </main>
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
        <ToastContainer />
        <div className="app-layout">
          <Sidebar 
            currentPage={currentPage} 
            onNavigate={setCurrentPage}
            onOpenSettings={() => setShowSettings(true)}
            nodeDisconnected={!connected && !!error}
          />
          <div className="app-content">
        <header className="header">
              <div className="header-title">
                <h1>Marketplace</h1>
              </div>
              <NodeStatusIndicator
                connected={connected}
                error={error}
                onClick={handleRestartNode}
                developerMode={getSettings().developerMode}
                runningNodes={runningNodes}
                currentNodeUrl={getSettings().nodeUrl}
                onSelectNode={handleSelectNode}
              />
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
        <ToastContainer />
        <div className="app-layout">
          <Sidebar 
            currentPage={currentPage} 
            onNavigate={setCurrentPage}
            onOpenSettings={() => setShowSettings(true)}
            nodeDisconnected={!connected && !!error}
          />
          <div className="app-content">
        <header className="header">
              <div className="header-title">
                <h1>Applications</h1>
              </div>
              <NodeStatusIndicator
                connected={connected}
                error={error}
                onClick={handleRestartNode}
                developerMode={getSettings().developerMode}
                runningNodes={runningNodes}
                currentNodeUrl={getSettings().nodeUrl}
                onSelectNode={handleSelectNode}
              />
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
        <ToastContainer />
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
            nodeDisconnected={!connected && !!error}
          />
          <div className="app-content">
            <header className="header">
              <div className="header-title">
                <h1>Nodes</h1>
              </div>
              <NodeStatusIndicator
                connected={connected}
                error={error}
                onClick={handleRestartNode}
                developerMode={getSettings().developerMode}
                runningNodes={runningNodes}
                currentNodeUrl={getSettings().nodeUrl}
                onSelectNode={handleSelectNode}
              />
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
        <ToastContainer />
        <div className="app-layout">
          <Sidebar 
            currentPage={currentPage} 
            onNavigate={setCurrentPage}
            onOpenSettings={() => setShowSettings(true)}
            nodeDisconnected={!connected && !!error}
          />
          <div className="app-content">
        <header className="header">
              <div className="header-title">
                <h1>Contexts</h1>
              </div>
              <NodeStatusIndicator
                connected={connected}
                error={error}
                onClick={handleRestartNode}
                developerMode={getSettings().developerMode}
                runningNodes={runningNodes}
                currentNodeUrl={getSettings().nodeUrl}
                onSelectNode={handleSelectNode}
              />
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
        <ToastContainer />
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
          nodeDisconnected={!connected && !!error}
        />
        
        <div className="app-content">
      <header className="header">
            <div className="header-title">
              <h1>{pageTitle}</h1>
              {appVersion && (
                <span className="version-badge">v{appVersion}</span>
              )}
            </div>
            <NodeStatusIndicator
              connected={connected}
              error={error}
              onClick={handleRestartNode}
              developerMode={getSettings().developerMode}
              runningNodes={runningNodes}
              currentNodeUrl={getSettings().nodeUrl}
              onSelectNode={handleSelectNode}
            />
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
              <div className="status-error-block">
                <p className="status-error">{error}</p>
                <p className="status-error-hint">
                  Your node may have stopped (e.g. after your computer slept). Click Restart Node to start it again.
                </p>
                <button
                  onClick={handleRestartNode}
                  className="button button-primary button-small"
                >
                  Restart Node
                </button>
              </div>
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
                  <div key={app.id} className="app-card-mini-wrapper">
                    <button
                      type="button"
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
                    {frontendUrl && (
                      <button
                        type="button"
                        className="app-card-shortcut-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCreateDesktopShortcut(appName, frontendUrl);
                        }}
                        title="Create desktop shortcut"
                      >
                        Shortcut
                      </button>
                    )}
                  </div>
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

