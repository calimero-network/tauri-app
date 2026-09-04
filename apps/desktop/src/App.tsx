import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense, type ReactNode } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { createClientAsync, apiClient } from "./lib/mero-client";
import { MeroContext, type MeroContextValue } from "@calimero-network/mero-react";
import { LoginView } from "./components/LoginView";
import { getAccessToken, clearAccessToken, clearRefreshToken } from "./lib/token-storage";
import { startTokenBroker } from "./lib/token-broker";
import {
  getSettings,
  getAuthUrl,
  saveSettings,
  DEFAULT_EMBEDDED_NODE_PORT,
  DEFAULT_EMBEDDED_SWARM_PORT,
  DEFAULT_NODE_HOME_DIR,
} from "./utils/settings";
import { clearOnboardingProgress } from "./utils/onboardingProgress";
import { startMerod, detectRunningMerodNodes, waitForNodeHealthy, findRunningNode, pollUntilNodeReady, type RunningMerodNode } from "./utils/merod";
import { homeDir } from "@tauri-apps/api/path";
import { useToast } from "./contexts/ToastContext";
import { checkOnboardingState } from "./utils/onboarding";
import { openAppFrontend, parseTauriError } from "./utils/appUtils";
import { useAppDeepLink } from "./hooks/useAppDeepLink";
import UpdateNotification from "./components/UpdateNotification";
import Sidebar from "./components/Sidebar";
import { NodeStatusIndicator } from "./components/NodeStatusIndicator";
import ToastContainer from "./components/ToastContainer";
import { getCurrentVersion } from "./utils/updater";
import { invoke } from "@tauri-apps/api/core";
import { Settings as SettingsIcon } from "lucide-react";
import calimeroLogo from "./assets/calimero-logo.svg";
import { useTheme } from "./contexts/ThemeContext";
import { useNodeVersions } from "./contexts/NodeVersionsContext";
import "./App.css";

// Only one page renders at a time, so keep them out of the initial bundle.
const Home = lazy(() => import("./pages/Home"));
const Settings = lazy(() => import("./pages/Settings"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const InstalledApps = lazy(() => import("./pages/InstalledApps"));
const Namespaces = lazy(() => import("./pages/Namespaces"));
const NodeManagement = lazy(() => import("./pages/NodeManagement"));
const ConfirmAction = lazy(() => import("./pages/ConfirmAction"));

type Page = 'home' | 'marketplace' | 'installed' | 'namespaces' | 'nodes' | 'confirm';

// 'confirm' takes over the whole window rather than rendering inside the shell.
type ShellPage = Exclude<Page, 'confirm'>;

function App() {
  const toast = useToast();
  const { theme } = useTheme();
  const { refresh: refreshNodeVersions } = useNodeVersions();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);
  const [clientReady, setClientReady] = useState(false);
  const [clientVersion, setClientVersion] = useState(0);
  const [needsNodeConfig, setNeedsNodeConfig] = useState(false);
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

  // Expose the adapter's MeroJs instance to mero-react hooks (useNamespaces, etc.)
  // Include showLogin in deps so the value refreshes after login completes
  // (isAuthenticated re-reads the token, mero re-reads apiClient.meroJs).
  const meroContextValue = useMemo<MeroContextValue>(() => ({
    mero: clientReady ? apiClient.meroJs : null,
    isAuthenticated: !!getAccessToken(),
    isOnline: connected,
    nodeUrl: getSettings().nodeUrl,
    applicationId: null,
    contextId: null,
    contextIdentity: null,
    connectToNode: () => {},
    logout: () => { clearAccessToken(); clearRefreshToken(); window.location.reload(); },
    isLoading: checkingOnboarding,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [clientReady, clientVersion, connected, checkingOnboarding, showLogin]);

  const handleSelectNode = useCallback(async (nodeUrl: string) => {
    const settings = getSettings();
    if (settings.nodeUrl !== nodeUrl) {
      // Clear auth tokens — old tokens are invalid for the new node
      await clearAccessToken();
      await clearRefreshToken();
      localStorage.removeItem('calimero-auth-tokens');
    }
    saveSettings({ ...settings, nodeUrl });
    window.location.reload();
  }, []);

  // Load app version
  useEffect(() => {
    getCurrentVersion().then(setAppVersion);
  }, []);

  // Each set_tray_icon_connected decodes a PNG on the Rust side, and the health
  // poll asks for the same value every tick. Only send changes; a failed send
  // clears the guard so the next tick retries.
  const trayConnected = useRef<boolean | null>(null);
  const updateTrayIcon = useCallback((connected: boolean) => {
    if (trayConnected.current === connected) return;
    trayConnected.current = connected;
    invoke("set_tray_icon_connected", { connected }).catch((err) => {
      trayConnected.current = null;
      console.warn("Failed to update tray icon:", err);
    });
  }, []);

  const initRan = useRef(false);

  useEffect(() => {
    // StrictMode remounts effects in dev; without the guard the whole init
    // chain runs twice per launch.
    if (initRan.current) return;
    initRan.current = true;

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
        setNeedsNodeConfig(true);
        setShowOnboarding(true);
        setCheckingOnboarding(false);
        return;
      }


      // Returning user - onboarding was completed. Never show onboarding again.
      // Initialize client and go to main app (with login if needed, disconnected if node down).
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
        let runningNodes = await detectRunningMerodNodes();
        setRunningNodes(runningNodes);

        const managedHomeDir = settings.embeddedNodeDataDir || DEFAULT_NODE_HOME_DIR;
        // No fallback here: a wrong osHomeDir risks the double-spawn this guard
        // exists to prevent, so a failure aborts via the outer catch instead of guessing.
        const osHomeDir = await homeDir();
        let adoptableNode = findRunningNode(runningNodes, managedHomeDir, settings.embeddedNodeName ?? '', osHomeDir);

        // Called even if a node is already running in the managed home: start_merod
        // adopts it rather than double-spawning, which is what lets the app stop it on quit.
        if (settings.embeddedNodeName) {
          const serverPort = settings.embeddedNodePort ?? DEFAULT_EMBEDDED_NODE_PORT;
          // Must come from settings: start_merod rewrites config.toml with whatever it
          // gets, so a hardcoded default here silently reverted a node the user had
          // created on a different swarm port.
          const swarmPort = settings.embeddedNodeSwarmPort ?? DEFAULT_EMBEDDED_SWARM_PORT;
          try {
            await startMerod(serverPort, swarmPort, managedHomeDir, settings.embeddedNodeName, settings.debugLogs);
            // Non-fatal on timeout: the health check below is what decides connected state.
            await waitForNodeHealthy(`http://localhost:${serverPort}/auth`, 15000).catch(() => {});
            runningNodes = await detectRunningMerodNodes();
            setRunningNodes(runningNodes);
            adoptableNode = findRunningNode(runningNodes, managedHomeDir, settings.embeddedNodeName ?? '', osHomeDir);
          } catch (startErr) {
            console.warn('Auto-start merod failed:', startErr);
          }
        }

        // Never adopts a node on a different home - that node isn't ours to hand the UI to.
        // In developer mode, never auto-override: the user manages the connection explicitly.
        if (adoptableNode && !settings.developerMode) {
          const node = adoptableNode;
          const nodeUrl = `http://localhost:${node.port}`;
          const currentUrl = settings.nodeUrl;
          const isLocalhostUrl = currentUrl && (
            currentUrl.startsWith('http://localhost:') ||
            currentUrl.startsWith('http://127.0.0.1:')
          );
          if ((!currentUrl || isLocalhostUrl) && currentUrl !== nodeUrl) {
            saveSettings({ ...settings, nodeUrl });
            setCheckingOnboarding(false);
            window.location.reload();
            return;
          }
        }
      } catch (error) {
        console.error('Failed to check nodes:', error);
      }

      try {
        const rawNodeUrl = settings.nodeUrl;
        if (!rawNodeUrl?.trim()) {
          console.error('Missing nodeUrl after completed onboarding');
          setConnected(false);
          setError('Node URL is not configured');
          setNeedsNodeConfig(true);
          return;
        }

        // baseUrl should NOT include /admin-api - mero-js adds that internally
        const nodeBaseUrl = rawNodeUrl.replace(/\/$/, '');
        const authUrl = getAuthUrl(settings);
        const authBaseUrl = authUrl.replace(/\/$/, '');
        await createClientAsync({
          baseUrl: nodeBaseUrl,
          authBaseUrl: authBaseUrl,
          requestCredentials: 'omit',
        });
        setClientReady(true);

        const healthCheck = await Promise.race([
          apiClient.node.healthCheck(),
          new Promise<{ error: { message: string; code?: string } }>((resolve) =>
            setTimeout(() => resolve({ error: { message: 'Node not responding' } }), 3000)
          ),
        ]);

        if (healthCheck.error) {
          // Node down - show main app with disconnected indicator (user can click Open Nodes)
          setConnected(false);
          setError(healthCheck.error.message);
          setNeedsNodeConfig(false);
          updateTrayIcon(false);
          return;
        }

        setConnected(true);
        updateTrayIcon(true);
        setError(null);
        setNeedsNodeConfig(false);

        // Flow logic:
        // 1. FIRST: Check if user has existing tokens (already logged in)
        // 2. If no tokens AND auth not configured → Onboarding (first time)
        // 3. If no tokens AND auth configured → Login screen
        // 4. If auth service unavailable → Show error
        
        // PRIORITY: Check for existing tokens FIRST
        const existingToken = getAccessToken();
        console.log('🔑 Existing token check:', existingToken ? 'EXISTS' : 'NONE');

        if (!existingToken) {
          // No token — always show login. Onboarding is only shown when
          // onboardingCompleted=false (handled by the early return above).
          // Node switching, new nodes with no accounts, auth unavailable — all
          // go to login. LoginView handles both "create first account" and
          // "sign in with existing account" via requestToken.
          console.log('🔐 No token, showing login screen');
          setShowLogin(true);
        }
      } catch (err) {
        console.error('Failed to initialize client or check node:', err);
        setConnected(false);
        setError(parseTauriError(err));
        setNeedsNodeConfig(false);
        updateTrayIcon(false);
      } finally {
        setCheckingOnboarding(false);
      }
    }

    initializeApp();
  }, []);

  // Health-only check — no app loading. Keeps the status indicator up to date
  // without triggering re-renders of the app list on every tick.
  const checkConnection = useCallback(async () => {
    try {
      setError(null);
      const healthResponse = await apiClient.node.healthCheck();
      if (healthResponse.error) {
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
    } catch (err) {
      setConnected(false);
      const errorMessage = parseTauriError(err);
      setError(errorMessage);
      console.error("Connection error:", err);
      updateTrayIcon(false);
    }
  }, [updateTrayIcon]);

  const handleRestartNode = useCallback(async () => {
    const settings = getSettings();
    if (!settings.embeddedNodeName) {
      setCurrentPage('nodes');
      return;
    }
    try {
      const dataDir = settings.embeddedNodeDataDir || DEFAULT_NODE_HOME_DIR;
      const osHomeDir = await homeDir();
      // Decided from the process list, not the health check: an unauthenticated node
      // answers 401, which reads as dead even though it is running.
      const alreadyRunning = findRunningNode(
        await detectRunningMerodNodes().catch(() => []),
        dataDir,
        settings.embeddedNodeName ?? '',
        osHomeDir
      );
      toast.success(
        alreadyRunning ? "Node is already running - reconnecting..." : "Starting node..."
      );
      const serverPort = settings.embeddedNodePort ?? DEFAULT_EMBEDDED_NODE_PORT;
      const swarmPort = settings.embeddedNodeSwarmPort ?? DEFAULT_EMBEDDED_SWARM_PORT;
      // Route through startMerod either way - it adopts a live node instead of
      // double-spawning, keeping the backend's quit-time tracking accurate too.
      await startMerod(serverPort, swarmPort, dataDir, settings.embeddedNodeName, settings.debugLogs);
      if (!alreadyRunning) {
        await pollUntilNodeReady(() => apiClient.node.healthCheck());
      }
      await checkConnection();
    } catch (err) {
      toast.error(`Failed to start node: ${parseTauriError(err)}`);
    }
  }, [checkConnection, toast]);

  // Page props are hoisted out of the JSX below: the pages are memoized, and an
  // inline arrow would give them a new prop identity on every App render.
  const handleOnboardingComplete = useCallback(async () => {
    clearOnboardingProgress();
    const settings = getSettings();
    saveSettings({ ...settings, onboardingCompleted: true });
    try {
      await invoke("autostart_enable");
      localStorage.setItem("calimero-autostart-default-applied", "1");
    } catch {
      // Autostart may not be available
    }
    // Onboarding never runs initializeApp, so nothing has marked the client
    // ready - without this Home's app load and the health interval no-op.
    await createClientAsync({
      baseUrl: settings.nodeUrl.replace(/\/$/, ''),
      authBaseUrl: getAuthUrl(settings).replace(/\/$/, ''),
      requestCredentials: 'omit',
    });
    setClientReady(true);
    setShowLogin(false); // clear any stale login state from health checks during onboarding
    setShowOnboarding(false);
    setConnected(true);
    setError(null);
    // Onboarding may have pointed the node at a custom data dir.
    refreshNodeVersions();
  }, [refreshNodeVersions]);

  const handleOnboardingSettings = useCallback(() => {
    setShowOnboarding(false);
    setShowSettings(true);
  }, []);

  const handleSettingsBack = useCallback(async () => {
    // Reinitialize client BEFORE hiding Settings so the checkConnection useEffect
    // only fires after the client has tokens loaded from localStorage
    const settings = getSettings();
    // baseUrl should NOT include /admin-api - mero-js adds that internally
    const nodeBaseUrl = settings.nodeUrl.replace(/\/$/, '');
    const authUrl = getAuthUrl(settings);
    const authBaseUrl = authUrl.replace(/\/$/, '');

    // Reload client with new settings and await token loading
    await createClientAsync({
      baseUrl: nodeBaseUrl,
      authBaseUrl: authBaseUrl,
      requestCredentials: 'omit',
    });
    setClientReady(true);
    setClientVersion((v) => v + 1);

    // Hide settings only after client is ready - this triggers the checkConnection
    // useEffect, which needs a properly initialized client to avoid spurious 401 -> login
    setShowSettings(false);

    if (needsNodeConfig) {
      // After first-time settings, continue with app initialization
      setNeedsNodeConfig(false);

      // Check onboarding state
      setCheckingOnboarding(true);
      try {
        const state = await checkOnboardingState();

        // Determine what to show
        if (!state.authAvailable || !state.hasConfiguredProviders) {
          setShowOnboarding(true);
        } else if (!getAccessToken()) {
          setShowLogin(true);
        }
      } catch (err) {
        console.error('Failed to check onboarding state:', err);
        setShowOnboarding(true);
      } finally {
        setCheckingOnboarding(false);
      }
    }
  }, [needsNodeConfig]);

  const handleAuthRequired = useCallback(() => setShowLogin(true), []);

  const handleOpenSettings = useCallback(() => setShowSettings(true), []);

  const handleConfirmUninstall = useCallback((_appId: string, appName: string, onConfirm: () => Promise<void>) => {
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
  }, []);

  const handleConfirmCancel = useCallback(() => {
    // Go back to the previous page (contexts or installed)
    if (confirmAction?.breadcrumbs[1]?.onClick) {
      confirmAction.breadcrumbs[1].onClick();
    } else {
      setCurrentPage('home');
    }
    setConfirmAction(null);
  }, [confirmAction]);

  // Route incoming app deep-links (calimero://<slug>/<action>?<params> and the
  // https://links.calimero.network/... Universal Link) to the target app.
  // Gated on clientReady since resolution lists installed apps via the client.
  useAppDeepLink(clientReady);

  // Serve token refreshes for app windows. Refresh tokens are single-use
  // (calimero-network/core#3083), so the desktop keeps the only copy and is the
  // only rotator; app windows ask us instead of refreshing themselves. Must run
  // for the whole app lifetime — an app window can ask at any time.
  useEffect(() => {
    const unlisten = startTokenBroker();
    return () => { unlisten.then((off) => off()).catch(() => {}); };
  }, []);

  // Gated on clientReady - the unconfigured singleton 401s on non-default ports.
  // Not visibility-gated: the tray dot is the only UI while the window is hidden.
  useEffect(() => {
    if (!clientReady || showLogin || showSettings || showOnboarding) return;
    checkConnection();
    const interval = setInterval(checkConnection, 10000);
    return () => clearInterval(interval);
  }, [checkConnection, clientReady, showLogin, showSettings, showOnboarding]);

  // When launched from a desktop shortcut (--open-app-url / --open-app-name): open app, focus it, then hide main window
  useEffect(() => {
    if (checkingOnboarding) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const pending = await invoke<[string, string, string | null] | null>("get_pending_open_app");
        if (cancelled || !pending) return;
        const [url, name, appId] = pending;
        const windowLabel = await openAppFrontend(url, name, undefined, appId ? { applicationId: appId } : undefined);
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

  if (showOnboarding) {
    return (
      <Onboarding
        onComplete={handleOnboardingComplete}
        onSettings={handleOnboardingSettings}
      />
    );
  }

  // Show login if needed
  if (showLogin) {
    return (
      <ErrorBoundary componentName="Login">
        <div className="app login-screen" data-testid="login-screen">
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
                setShowLogin(false);
                checkConnection();
              }}
              onError={(error) => {
                console.error('❌ Login failed:', error);
              }}
            />
          </main>
        </div>
      </ErrorBoundary>
    );
  }


  if (showSettings) {
    return (
      <ErrorBoundary componentName="Settings">
        {/* Settings short-circuits the page shell, where the ToastContainer is
            mounted, so it needs its own or its toasts never render. */}
        <ToastContainer />
        <Settings onBack={handleSettingsBack} />
      </ErrorBoundary>
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
          onCancel={handleConfirmCancel}
          breadcrumbs={confirmAction.breadcrumbs}
        />
      </div>
    );
  }

  const shellPage: ShellPage = currentPage === 'confirm' ? 'home' : currentPage;

  const PAGES: Record<ShellPage, { title: string; element: ReactNode }> = {
    home: {
      title: 'Home',
      element: (
        <Home
          connected={connected}
          error={error}
          clientReady={clientReady}
          onReconnect={handleRestartNode}
          onNavigate={setCurrentPage}
          onOpenSettings={handleOpenSettings}
          onAuthRequired={handleAuthRequired}
        />
      ),
    },
    marketplace: {
      title: 'Marketplace',
      element: <Marketplace clientReady={clientReady} />,
    },
    installed: {
      title: 'Applications',
      element: (
        <InstalledApps
          clientReady={clientReady}
          onAuthRequired={handleAuthRequired}
          onConfirmUninstall={handleConfirmUninstall}
        />
      ),
    },
    namespaces: {
      title: 'Namespaces',
      element: (
        <MeroContext.Provider value={meroContextValue}>
          <Namespaces />
        </MeroContext.Provider>
      ),
    },
    nodes: {
      title: 'Nodes',
      element: <NodeManagement />,
    },
  };

  return (
    <div className="app">
      <ToastContainer />
      <UpdateNotification />

      <div className="app-layout">
        <Sidebar
          currentPage={shellPage}
          onNavigate={setCurrentPage}
          onOpenSettings={handleOpenSettings}
          nodeDisconnected={!connected && !!error}
        />

        <div className="app-content">
          <header className="header">
            <div className="header-title">
              <h1 data-testid="shell-page-title">{PAGES[shellPage].title}</h1>
              {shellPage === 'home' && appVersion && (
                <span className="version-badge">v{appVersion}</span>
              )}
            </div>
            <NodeStatusIndicator
              connected={connected}
              error={error}
              onClick={handleRestartNode}
              runningNodes={runningNodes}
              onSelectNode={handleSelectNode}
            />
          </header>

          {/* Own boundary so a page chunk loads under a painted shell, not a blank window. */}
          <main className="main">
            <Suspense fallback={null}>{PAGES[shellPage].element}</Suspense>
          </main>
        </div>
      </div>
    </div>
  );
}

export default App;

