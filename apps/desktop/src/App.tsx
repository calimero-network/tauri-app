import { useState, useEffect, useCallback, useMemo, useRef, lazy } from "react";
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
} from "./utils/settings";
import { clearOnboardingProgress } from "./utils/onboardingProgress";
import { startMerod, detectRunningMerodNodes, waitForNodeHealthy, type RunningMerodNode } from "./utils/merod";
import { homeDir } from "@tauri-apps/api/path";
import { useToast } from "./contexts/ToastContext";
import { checkOnboardingState } from "./utils/onboarding";
import { decodeMetadata, openAppFrontend, parseTauriError } from "./utils/appUtils";
import { listInstalledApps } from "./utils/installedAppsCache";
import { useAppDeepLink } from "./hooks/useAppDeepLink";
import UpdateNotification from "./components/UpdateNotification";
import Sidebar from "./components/Sidebar";
import { NodeStatusIndicator } from "./components/NodeStatusIndicator";
import ToastContainer from "./components/ToastContainer";
import { getCurrentVersion } from "./utils/updater";
import { invoke } from "@tauri-apps/api/core";
import { Settings as SettingsIcon, ArrowRight, Package, ShoppingCart } from "lucide-react";
import calimeroLogo from "./assets/calimero-logo.svg";
import { useTheme } from "./contexts/ThemeContext";
import { useNodeVersions } from "./contexts/NodeVersionsContext";
import "./App.css";

// Only one page renders at a time, so keep them out of the initial bundle.
const Settings = lazy(() => import("./pages/Settings"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const InstalledApps = lazy(() => import("./pages/InstalledApps"));
const Namespaces = lazy(() => import("./pages/Namespaces"));
const NodeManagement = lazy(() => import("./pages/NodeManagement"));
const ConfirmAction = lazy(() => import("./pages/ConfirmAction"));

// --- Node ownership guards -------------------------------------------------
//
// A node running on a home this app didn't create (e.g. a developer's own
// `merod --home ~/dev-nodes --node alice run`) must never be auto-adopted as
// settings.nodeUrl, and must never suppress this app's own auto-start - two
// independent RocksDB writers on the same data directory corrupt each other.
// Kept as pure functions so the ownership decision is unit-testable without
// mounting the app.

/** Normalize a home-dir path for comparison: trims a trailing slash and
 *  expands a leading `~` against the OS home dir, so a literal `~/.calimero`
 *  compares equal to the already-resolved absolute path merod runs under. */
function normalizeHomeDir(path: string | undefined | null, osHomeDir: string): string {
  if (!path) return '';
  const trimmed = path.trim().replace(/\/+$/, '');
  const home = osHomeDir.replace(/\/+$/, '');
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return home + trimmed.slice(1);
  return trimmed;
}

/** Running nodes whose home_dir resolves to the home this app manages. */
function nodesInManagedHome(
  nodes: RunningMerodNode[],
  managedHomeDir: string,
  osHomeDir: string
): RunningMerodNode[] {
  const managed = normalizeHomeDir(managedHomeDir, osHomeDir);
  return nodes.filter((n) => normalizeHomeDir(n.home_dir, osHomeDir) === managed);
}

export interface ManagedNodesDecision {
  /** True when no node from this app's managed home is currently running. */
  shouldAutoStart: boolean;
  /** The managed-home node to adopt as settings.nodeUrl, if any. */
  adopt?: RunningMerodNode;
}

/** Decide startup behaviour from the nodes currently detected on the system.
 *  Only nodes in the app's managed home count toward either decision. */
export function decideManagedNodes(
  nodes: RunningMerodNode[],
  managedHomeDir: string,
  osHomeDir: string
): ManagedNodesDecision {
  const managed = nodesInManagedHome(nodes, managedHomeDir, osHomeDir);
  return { shouldAutoStart: managed.length === 0, adopt: managed[0] };
}

/** Whether the init effect (and Restart) should call startMerod for the
 *  user's configured embedded node. The backend is the single decision point
 *  for adopting an already-running node vs spawning a new one, so this must
 *  not skip the call just because a managed-home node is already up -
 *  skipping it left that node outside the backend's tracked state, so
 *  quitting the app could never stop it. */
export function shouldStartMerod(embeddedNodeName: string | undefined): boolean {
  return !!embeddedNodeName;
}

export type RestartAction = 'reconnect' | 'start' | 'manage';

/** Decide what clicking "Restart"/"Reconnect" should do. A node already
 *  running for this app's home+node name is reconnected to, never
 *  double-spawned. This is process-list based, not HTTP-status based, so an
 *  unauthenticated (401) node - alive, just not logged in - never reads as
 *  dead. */
export function decideRestartAction(
  nodes: RunningMerodNode[],
  settings: { embeddedNodeName?: string; embeddedNodeDataDir?: string },
  osHomeDir: string
): RestartAction {
  if (!settings.embeddedNodeName) return 'manage';
  const managedHomeDir = settings.embeddedNodeDataDir || '~/.calimero';
  const alreadyRunning = nodesInManagedHome(nodes, managedHomeDir, osHomeDir).some(
    (n) => n.node_name === settings.embeddedNodeName
  );
  return alreadyRunning ? 'reconnect' : 'start';
}

function App() {
  const toast = useToast();
  const { theme } = useTheme();
  const { refresh: refreshNodeVersions } = useNodeVersions();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [currentPage, setCurrentPage] = useState<'home' | 'marketplace' | 'installed' | 'namespaces' | 'nodes' | 'confirm'>('home');
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);
  const [clientReady, setClientReady] = useState(false);
  const [clientVersion, setClientVersion] = useState(0);
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

  // Load installed apps for main page
  const loadInstalledApps = useCallback(async () => {
    // Until the client is configured, the singleton falls back to its hardcoded
    // localhost:2528, so a node on any other port answers 401 and forces login.
    if (!clientReady) return;
    setLoadingApps(true);
    try {
      const response = await listInstalledApps();
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
  }, [showOnboarding, clientReady]);

  // Load contexts for main page (only if developer mode)
  const loadContexts = useCallback(async () => {
    if (!clientReady) {
      console.log('⏳ loadContexts: Client not ready yet, skipping');
      return;
    }
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
  }, [clientReady, showOnboarding]);

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
    // initializeApp sets clientReady, which rebuilds loadContexts and re-fires this
    // effect; without the guard the whole init chain runs twice per launch.
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
        const normalizeRunningNodes = (n: unknown): RunningMerodNode[] =>
          Array.isArray(n) ? n : [];
        let runningNodes = normalizeRunningNodes(await detectRunningMerodNodes());
        setRunningNodes(runningNodes);

        const managedHomeDir = settings.embeddedNodeDataDir || '~/.calimero';
        // No fallback on failure: a wrong osHomeDir (e.g. '') could make a real
        // managed node under '~/...' stop matching, which risks the double-spawn
        // this guard exists to prevent - safer to abort via the outer catch.
        const osHomeDir = await homeDir();
        let managedDecision = decideManagedNodes(runningNodes, managedHomeDir, osHomeDir);

        // Call startMerod whenever an embedded node is configured, even if one is
        // already running in the managed home - start_merod adopts a live node
        // instead of double-spawning, and adoption is what lets the app stop it on
        // quit. A node on some other home - e.g. a developer's own
        // `merod --home ~/dev-nodes` - is never touched by this at all.
        if (shouldStartMerod(settings.embeddedNodeName)) {
          const serverPort = settings.embeddedNodePort ?? DEFAULT_EMBEDDED_NODE_PORT;
          // Must come from settings: start_merod rewrites config.toml with whatever it
          // gets, so a hardcoded default here silently reverted a node the user had
          // created on a different swarm port.
          const swarmPort = settings.embeddedNodeSwarmPort ?? DEFAULT_EMBEDDED_SWARM_PORT;
          try {
            await startMerod(serverPort, swarmPort, managedHomeDir, settings.embeddedNodeName, settings.debugLogs);
            // Non-fatal on timeout: the health check below is what decides connected state.
            await waitForNodeHealthy(`http://localhost:${serverPort}/auth`, 15000).catch(() => {});
            runningNodes = normalizeRunningNodes(await detectRunningMerodNodes());
            setRunningNodes(runningNodes);
            managedDecision = decideManagedNodes(runningNodes, managedHomeDir, osHomeDir);
          } catch (startErr) {
            console.warn('Auto-start merod failed:', startErr);
          }
        }

        // Auto-update nodeUrl if we detect our own running node and user has no URL set.
        // Never adopts a node on a different home - that node isn't ours to hand the UI
        // to. In developer mode, never auto-override — the user explicitly manages which
        // node to connect to (via NodeManagement or the dropdown). Auto-overriding here
        // races with the reload from NodeManagement and silently reverts the user's
        // selection.
        if (managedDecision.adopt && !settings.developerMode) {
          const node = managedDecision.adopt;
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
          loadContexts().catch(() => {});
          loadInstalledApps().catch(() => {});
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
        
        if (existingToken) {
          // User has token - try to use it (mero-js will refresh if needed)
          console.log('✅ User has existing token, loading contexts');
          loadContexts();
          loadInstalledApps();
        } else {
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
        loadContexts().catch(() => {});
        loadInstalledApps().catch(() => {});
        updateTrayIcon(false);
      } finally {
        setCheckingOnboarding(false);
      }
    }

    initializeApp();
  }, [loadContexts]);

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
    if (settings.embeddedNodeName) {
      try {
        // No fallback on failure: a wrong osHomeDir (e.g. '') could make a real
        // managed node under '~/...' stop matching, which risks the double-spawn
        // this guard exists to prevent - safer to abort via the outer catch.
        const osHomeDir = await homeDir();
        const nodes = await detectRunningMerodNodes().catch(() => []);
        const action = decideRestartAction(Array.isArray(nodes) ? nodes : [], settings, osHomeDir);
        toast.success(
          action === 'reconnect' ? "Node is already running - reconnecting..." : "Starting node..."
        );
        const dataDir = settings.embeddedNodeDataDir || '~/.calimero';
        const serverPort = settings.embeddedNodePort ?? DEFAULT_EMBEDDED_NODE_PORT;
        const swarmPort = settings.embeddedNodeSwarmPort ?? DEFAULT_EMBEDDED_SWARM_PORT;
        // Route through startMerod either way - it adopts an already-running node
        // instead of double-spawning, which is what keeps the backend's tracked
        // state (used to stop nodes on quit) accurate for a reconnect too.
        await startMerod(serverPort, swarmPort, dataDir, settings.embeddedNodeName, settings.debugLogs);
        if (action === 'start') {
          await new Promise((r) => setTimeout(r, 3000));
        }
        await checkConnection();
      } catch (err) {
        toast.error(`Failed to start node: ${parseTauriError(err)}`);
      }
    } else {
      setCurrentPage('nodes');
    }
  }, [checkConnection, toast]);

  // Open app frontend in a new window
  const handleOpenAppFrontend = useCallback(async (frontendUrl: string, appName?: string, applicationId?: string, iconData?: string) => {
    try {
      await openAppFrontend(frontendUrl, appName, undefined, applicationId ? { applicationId, iconData } : undefined);
    } catch (error) {
      // Fallback to navigating to installed apps page
      setCurrentPage('installed');
    }
  }, []);

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
    // ready - without this the loads below and the health interval no-op.
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
    loadContexts().catch(() => {});
    loadInstalledApps().catch(() => {});
  }, [loadContexts, loadInstalledApps, refreshNodeVersions]);

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
        } else {
          loadContexts();
          loadInstalledApps();
        }
      } catch (err) {
        console.error('Failed to check onboarding state:', err);
        setShowOnboarding(true);
      } finally {
        setCheckingOnboarding(false);
      }
    } else {
      // Settings changed, reload contexts if logged in
      if (getAccessToken()) {
        loadContexts();
        loadInstalledApps();
      }
    }
  }, [needsNodeConfig, loadContexts, loadInstalledApps]);

  const handleAuthRequired = useCallback(() => setShowLogin(true), []);

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

  // Load apps + contexts only when the user is on the home page.
  // Fires once on navigation — not on every health-check tick.
  useEffect(() => {
    if (showLogin || showSettings || showOnboarding) return;
    if (currentPage !== 'home' || !clientReady) return;
    loadContexts().catch(() => {});
    loadInstalledApps().catch(() => {});
  }, [currentPage, clientReady, showLogin, showSettings, showOnboarding, loadContexts, loadInstalledApps]);

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

  // Calculate page title and sidebar page before early returns
  const sidebarPage: 'home' | 'marketplace' | 'installed' | 'namespaces' | 'nodes' =
    currentPage === 'confirm' ? 'home' : currentPage;

  let pageTitle: string;
  switch (currentPage) {
    case 'home':
      pageTitle = 'Home';
      break;
    case 'nodes':
      pageTitle = 'Nodes';
      break;
    case 'namespaces':
      pageTitle = 'Namespaces';
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
        onComplete={handleOnboardingComplete}
        onSettings={handleOnboardingSettings}
      />
    );
  }

  // Show login if needed
  if (showLogin) {
    return (
      <ErrorBoundary componentName="Login" onReset={() => setShowLogin(true)}>
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
      </ErrorBoundary>
    );
  }


  if (showSettings) {
    return (
      <ErrorBoundary componentName="Settings" onReset={() => setShowSettings(true)}>
        <Settings onBack={handleSettingsBack} />
      </ErrorBoundary>
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
                <h1 data-testid="shell-page-title">Marketplace</h1>
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
                <Marketplace clientReady={clientReady} />
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
                <h1 data-testid="shell-page-title">Applications</h1>
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
          clientReady={clientReady}
          onAuthRequired={handleAuthRequired}
          onConfirmUninstall={handleConfirmUninstall}
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
              else if (p === 'namespaces') setCurrentPage('namespaces');
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
                <h1 data-testid="shell-page-title">Nodes</h1>
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

  // Show Namespaces if selected
  if (currentPage === 'namespaces') {
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
                <h1 data-testid="shell-page-title">Namespaces</h1>
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
              <MeroContext.Provider value={meroContextValue}>
                  <Namespaces />
              </MeroContext.Provider>
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
          onCancel={handleConfirmCancel}
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
            else if (p === 'namespaces') setCurrentPage('namespaces');
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
              <h1 data-testid="shell-page-title">{pageTitle}</h1>
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
                  Can't reach your node right now (e.g. after your computer slept). Click Reconnect to check its status again.
                </p>
                <button
                  onClick={handleRestartNode}
                  className="button button-primary button-small"
                >
                  Reconnect
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
                } catch (e) {
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
                        setCurrentPage('installed');
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

        {/* Empty State for Apps */}
        {!loadingApps && installedApps.length === 0 && (
          <div className="empty-state-card">
            <Package size={48} className="empty-icon" />
            <h3>No Applications Installed</h3>
            <p>Get started by browsing the marketplace and installing your first app.</p>
            <button
              onClick={() => setCurrentPage('marketplace')}
              className="btn-browse-marketplace"
            >
              <ShoppingCart size={16} className="browse-icon" />
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

