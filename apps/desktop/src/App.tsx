import { useState, useEffect } from "react";
import { MeroJs, type MeroJsConfig } from "@calimero-network/mero-js";
import { getSettings, getAuthUrl } from "./utils/settings";
import Settings from "./pages/Settings";
import "./App.css";

function App() {
  const [adminMeroJs, setAdminMeroJs] = useState<MeroJs | null>(null);
  const [authMeroJs, setAuthMeroJs] = useState<MeroJs | null>(null);
  const [connected, setConnected] = useState(false);
  const [authConnected, setAuthConnected] = useState(false);
  const [nodeInfo, setNodeInfo] = useState<any>(null);
  const [authInfo, setAuthInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [adminApiUrl, setAdminApiUrl] = useState("");
  const [authApiUrl, setAuthApiUrl] = useState("");

  useEffect(() => {
    // Load settings on startup
    const settings = getSettings();
    const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
    const authUrl = getAuthUrl(settings);
    const authBaseUrl = authUrl.replace(/\/$/, '');
    const authApiUrl = `${authBaseUrl}/auth`;
    
    setAdminApiUrl(adminApiUrl);
    setAuthApiUrl(authApiUrl);

    // Create admin MeroJs client
    const adminConfig: MeroJsConfig = {
      baseUrl: adminApiUrl,
      requestCredentials: 'omit', // Required for Tauri
    };
    const adminClient = new MeroJs(adminConfig);
    setAdminMeroJs(adminClient);

    // Create auth MeroJs client (if different URL)
    if (authBaseUrl !== settings.nodeUrl.replace(/\/$/, '')) {
      const authConfig: MeroJsConfig = {
        baseUrl: authBaseUrl,
        requestCredentials: 'omit',
      };
      const authClient = new MeroJs(authConfig);
      setAuthMeroJs(authClient);
    } else {
      // Use same client for auth (but with node base URL, not admin-api)
      const authConfig: MeroJsConfig = {
        baseUrl: settings.nodeUrl.replace(/\/$/, ''),
        requestCredentials: 'omit',
      };
      const authClient = new MeroJs(authConfig);
      setAuthMeroJs(authClient);
    }
  }, []);

  const checkConnection = async () => {
    if (!adminMeroJs) return;

    try {
      setError(null);
      
      // Check admin health
      const health = await adminMeroJs.admin.healthCheck();
      setConnected(health.status === "ok" || health.status === "healthy" || health.status === "alive");
      
      if (health.status === "ok" || health.status === "healthy" || health.status === "alive") {
        try {
          const apps = await adminMeroJs.admin.listApplications();
          const contexts = await adminMeroJs.admin.getContexts();
          setNodeInfo({
            health,
            applications: apps,
            contexts: contexts,
          });
        } catch (infoErr) {
          // If we can't get additional info, just show health
          setNodeInfo({ health });
        }
      }

      // Check auth health
      if (authMeroJs) {
        try {
          setAuthError(null);
          const authHealth = await authMeroJs.auth.getHealth();
          setAuthConnected(authHealth.status === "healthy");
          setAuthInfo({ health: authHealth });
        } catch (authErr) {
          setAuthConnected(false);
          setAuthInfo(null);
          const errorMessage = authErr instanceof Error ? authErr.message : String(authErr);
          setAuthError(errorMessage);
          console.error("Auth health check error:", authErr);
        }
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

    // Create admin client
    const adminConfig: MeroJsConfig = {
      baseUrl: adminApiUrl,
      requestCredentials: 'omit',
    };
    const adminClient = new MeroJs(adminConfig);
    setAdminMeroJs(adminClient);

    // Create auth client
    if (authBaseUrl !== settings.nodeUrl.replace(/\/$/, '')) {
      const authConfig: MeroJsConfig = {
        baseUrl: authBaseUrl,
        requestCredentials: 'omit',
      };
      const authClient = new MeroJs(authConfig);
      setAuthMeroJs(authClient);
    } else {
      // Use same base URL as node (not admin-api)
      const authConfig: MeroJsConfig = {
        baseUrl: settings.nodeUrl.replace(/\/$/, ''),
        requestCredentials: 'omit',
      };
      const authClient = new MeroJs(authConfig);
      setAuthMeroJs(authClient);
    }

    setConnected(false);
    setAuthConnected(false);
    setNodeInfo(null);
    setAuthInfo(null);
    setError(null);
    setAuthError(null);
  };

  const checkAuthHealth = async () => {
    if (!authMeroJs) return;

    try {
      setAuthError(null);
      const authHealth = await authMeroJs.auth.getHealth();
      setAuthConnected(authHealth.status === "healthy");
      setAuthInfo({ health: authHealth });
    } catch (authErr) {
      setAuthConnected(false);
      setAuthInfo(null);
      const errorMessage = authErr instanceof Error ? authErr.message : String(authErr);
      setAuthError(errorMessage);
      console.error("Auth health check error:", authErr);
    }
  };

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

