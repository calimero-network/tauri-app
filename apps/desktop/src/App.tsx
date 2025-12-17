import { useState, useEffect, useCallback } from "react";
import { createClient, apiClient, LoginView, getAccessToken } from "@calimero-network/mero-react";
import { getSettings, getAuthUrl } from "./utils/settings";
import { checkOnboardingState, type OnboardingState } from "./utils/onboarding";
import Settings from "./pages/Settings";
import Onboarding from "./pages/Onboarding";
import Marketplace from "./pages/Marketplace";
import "./App.css";

function App() {
  const [connected, setConnected] = useState(false);
  const [authConnected, setAuthConnected] = useState(false);
  const [nodeInfo, setNodeInfo] = useState<any>(null);
  const [authInfo, setAuthInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [currentPage, setCurrentPage] = useState<'home' | 'marketplace'>('home');
  const [onboardingState, setOnboardingState] = useState<OnboardingState | null>(null);
  const [checkingOnboarding, setCheckingOnboarding] = useState(true);
  const [needsNodeConfig, setNeedsNodeConfig] = useState(false);
  const [adminApiUrl, setAdminApiUrl] = useState("");
  const [authApiUrl, setAuthApiUrl] = useState("");
  const [contexts, setContexts] = useState<any[]>([]);

  // Load contexts for main page
  const loadContexts = useCallback(async () => {
    try {
      const contextsResponse = await apiClient.node.getContexts();
      if (contextsResponse.error) {
        // If 401, show login
        if (contextsResponse.error.code === '401') {
          setShowLogin(true);
          return;
        }
        console.error('❌ Contexts error:', contextsResponse.error.message);
        return;
      }
      if (contextsResponse.data) {
        setContexts(contextsResponse.data);
      }
    } catch (err: any) {
      // Check for 401 in error object
      if (err?.status === 401) {
        setShowLogin(true);
        return;
      }
      console.error('Failed to load contexts:', err);
    }
  }, []);

  useEffect(() => {
    async function initializeApp() {
      // Load settings on startup
      const settings = getSettings();
      
      // Check if settings need to be configured (first time)
      const hasCustomSettings = localStorage.getItem('calimero-desktop-settings') !== null;
      if (!hasCustomSettings) {
        // First time - show settings first to configure node
        console.log('📋 First time setup - showing settings');
        setNeedsNodeConfig(true);
        setShowSettings(true);
        return;
      }
      
      const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
      const authUrl = getAuthUrl(settings);
      const authBaseUrl = authUrl.replace(/\/$/, '');
      const authApiUrl = `${authBaseUrl}/auth`;
      
      setAdminApiUrl(adminApiUrl);
      setAuthApiUrl(authApiUrl);

      // Initialize mero-react client
      createClient({
        baseUrl: adminApiUrl,
        authBaseUrl: authBaseUrl,
        requestCredentials: 'omit',
      });

      // Check onboarding state
      setCheckingOnboarding(true);
      const state = await checkOnboardingState();
      setOnboardingState(state);
      setCheckingOnboarding(false);

      // Debug logging
      console.log('🔍 Onboarding State:', {
        isFirstTime: state.isFirstTime,
        authAvailable: state.authAvailable,
        providersAvailable: state.providersAvailable,
        hasConfiguredProviders: state.hasConfiguredProviders,
        error: state.error,
      });

      // Flow logic:
      // 1. If auth is NOT configured (no users) → Onboarding (first time, create account)
      // 2. If auth IS configured (has users) → Check if logged in
      //    - Not logged in → Login screen
      //    - Logged in → Main app
      // 3. If auth service unavailable → Show error in onboarding
      
      if (!state.authAvailable) {
        // Auth service not available - show onboarding with error
        console.log('⚠️ Auth service not available, showing onboarding with error');
        setShowOnboarding(true);
      } else if (!state.hasConfiguredProviders) {
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
          // User has token, try to load contexts
          console.log('✅ User logged in, loading contexts');
          loadContexts();
        }
      }
    }

    initializeApp();
  }, [loadContexts]);

  const checkConnection = async () => {
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
      
      if (healthResponse.data) {
        setConnected(healthResponse.data.status === "ok" || 
                    healthResponse.data.status === "healthy" || 
                    healthResponse.data.status === "alive");
        setNodeInfo({ health: healthResponse.data });
      }

      // Check auth health
      const providersResponse = await apiClient.auth.getProviders();
      if (providersResponse.error) {
        console.error('❌ Providers error:', providersResponse.error.message);
        setAuthError(providersResponse.error.message);
        setAuthConnected(false);
      } else {
        setAuthConnected(true);
        setAuthInfo({ providers: providersResponse.data });
      }

      // Load contexts after successful connection
      if (connected) {
        await loadContexts();
      }
    } catch (err) {
      setConnected(false);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setNodeInfo(null);
      console.error("Connection error:", err);
    }
  };

  // Reload client when settings change
  const reloadClient = () => {
    const settings = getSettings();
    const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
    const authUrl = getAuthUrl(settings);
    const authBaseUrl = authUrl.replace(/\/$/, '');
    const authApiUrl = `${authBaseUrl}/auth`;
    
    setAdminApiUrl(adminApiUrl);
    setAuthApiUrl(authApiUrl);

    // Reinitialize mero-react client
    createClient({
      baseUrl: adminApiUrl,
      authBaseUrl: authBaseUrl,
      requestCredentials: 'omit',
    });

    setConnected(false);
    setAuthConnected(false);
    setNodeInfo(null);
    setAuthInfo(null);
    setError(null);
    setAuthError(null);
  };

  const checkAuthHealth = async () => {
    try {
      setAuthError(null);
      
      // Test auth API
      const providersResponse = await apiClient.auth.getProviders();
      if (providersResponse.error) {
        setAuthError(providersResponse.error.message);
        setAuthConnected(false);
      } else {
        setAuthConnected(true);
        setAuthInfo({ providers: providersResponse.data });
      }
    } catch (authErr) {
      setAuthConnected(false);
      setAuthInfo(null);
      const errorMessage = authErr instanceof Error ? authErr.message : String(authErr);
      setAuthError(errorMessage);
      console.error("Auth health check error:", authErr);
    }
  };

  // Show onboarding if needed
  if (checkingOnboarding) {
    return (
      <div className="app">
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <p>Checking configuration...</p>
        </div>
      </div>
    );
  }

  if (showOnboarding && onboardingState) {
    return (
      <Onboarding
        onComplete={() => {
          setShowOnboarding(false);
          // After onboarding, try to load contexts
          loadContexts();
          checkConnection();
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
      <LoginView
        onSuccess={() => {
          console.log('✅ Login successful');
          setShowLogin(false);
          // Reload contexts after login
          loadContexts();
          checkConnection();
        }}
        onError={(error) => {
          console.error('❌ Login failed:', error);
        }}
      />
    );
  }

  if (showSettings) {
    return (
      <Settings
        onBack={async () => {
          setShowSettings(false);
          if (needsNodeConfig) {
            // After first-time settings, continue with app initialization
            setNeedsNodeConfig(false);
            
            // Reload settings and initialize
            const settings = getSettings();
            const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
            const authUrl = getAuthUrl(settings);
            const authBaseUrl = authUrl.replace(/\/$/, '');
            const authApiUrl = `${authBaseUrl}/auth`;
            
            setAdminApiUrl(adminApiUrl);
            setAuthApiUrl(authApiUrl);

            // Initialize mero-react client
            createClient({
              baseUrl: adminApiUrl,
              authBaseUrl: authBaseUrl,
              requestCredentials: 'omit',
            });

            // Check onboarding state
            setCheckingOnboarding(true);
            const state = await checkOnboardingState();
            setOnboardingState(state);
            setCheckingOnboarding(false);

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
              }
            }
          } else {
            reloadClient();
          }
        }}
      />
    );
  }

  // Show Marketplace if selected
  if (currentPage === 'marketplace') {
    return (
      <div className="app">
        <header className="header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <button onClick={() => setCurrentPage('home')} className="button" style={{ background: '#f0f0f0' }}>
              ← Home
            </button>
            <h1>Application Marketplace</h1>
          </div>
          <button onClick={() => setShowSettings(true)} className="settings-button">
            ⚙️ Settings
          </button>
        </header>
        <Marketplace />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Calimero Desktop</h1>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={() => setCurrentPage('marketplace')} className="button" style={{ background: '#007bff', color: 'white' }}>
            🛒 Marketplace
          </button>
          <button onClick={() => setShowSettings(true)} className="settings-button">
            ⚙️ Settings
          </button>
        </div>
      </header>

      <main className="main">
        <div className="card">
          <h2>Node Connection</h2>
          <p className="url">URL: {adminApiUrl || "Loading..."}</p>
          
          <div className="status">
            <div className={`status-indicator ${connected ? "connected" : "disconnected"}`} />
            <span>{connected ? "Connected" : "Disconnected"}</span>
          </div>

          <button onClick={checkConnection} className="button">
            Check Connection
          </button>

          {error && <div className="error">{error}</div>}

          {nodeInfo && (
            <div className="node-info">
              <h3>Node Information</h3>
              <pre>{JSON.stringify(nodeInfo, null, 2)}</pre>
            </div>
          )}

          {contexts.length > 0 && (
            <div className="node-info">
              <h3>Contexts ({contexts.length})</h3>
              <pre>{JSON.stringify(contexts, null, 2)}</pre>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Auth Connection</h2>
          <p className="url">URL: {authApiUrl || "Loading..."}</p>
          
          <div className="status">
            <div className={`status-indicator ${authConnected ? "connected" : "disconnected"}`} />
            <span>{authConnected ? "Connected" : "Disconnected"}</span>
          </div>

          <button onClick={checkAuthHealth} className="button">
            Check Auth Health
          </button>

          {authError && <div className="error">{authError}</div>}

          {authInfo && (
            <div className="node-info">
              <h3>Auth Information</h3>
              <pre>{JSON.stringify(authInfo, null, 2)}</pre>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;

