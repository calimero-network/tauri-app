import { useState, useEffect, useCallback } from "react";
import { createClient, apiClient, LoginView } from "@calimero-network/mero-react";
import { getSettings, getAuthUrl } from "./utils/settings";
import Settings from "./pages/Settings";
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
    // Load settings on startup
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

    // Try to load contexts on startup
    loadContexts();
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
    return <Settings onBack={() => { setShowSettings(false); reloadClient(); }} />;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Calimero Desktop</h1>
        <button onClick={() => setShowSettings(true)} className="settings-button">
          ⚙️ Settings
        </button>
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

