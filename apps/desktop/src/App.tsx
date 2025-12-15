import { useState, useEffect } from "react";
import { MeroJs, type MeroJsConfig } from "@calimero-network/mero-js";
import { getSettings } from "./utils/settings";
import Settings from "./pages/Settings";
import "./App.css";

function App() {
  const [meroJs, setMeroJs] = useState<MeroJs | null>(null);
  const [connected, setConnected] = useState(false);
  const [nodeInfo, setNodeInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [adminApiUrl, setAdminApiUrl] = useState("");

  useEffect(() => {
    // Load settings on startup
    const settings = getSettings();
    const adminApiUrl = `${settings.nodeUrl.replace(/\/$/, '')}/admin-api`;
    setAdminApiUrl(adminApiUrl);

    // Create MeroJs client with config
    const config: MeroJsConfig = {
      baseUrl: adminApiUrl,
      requestCredentials: 'omit', // Required for Tauri
    };
    
    const client = new MeroJs(config);
    setMeroJs(client);
  }, []);

  const checkConnection = async () => {
    if (!meroJs) return;

    try {
      setError(null);
      
      const health = await meroJs.admin.healthCheck();
      setConnected(health.status === "ok" || health.status === "healthy" || health.status === "alive");
      
      if (health.status === "ok" || health.status === "healthy" || health.status === "alive") {
        try {
          const apps = await meroJs.admin.listApplications();
          const contexts = await meroJs.admin.getContexts();
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
    setAdminApiUrl(adminApiUrl);

    const config: MeroJsConfig = {
      baseUrl: adminApiUrl,
      requestCredentials: 'omit',
    };
    
    const client = new MeroJs(config);
    setMeroJs(client);
    setConnected(false);
    setNodeInfo(null);
    setError(null);
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
      </main>
    </div>
  );
}

export default App;

