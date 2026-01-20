import { useState, useEffect } from "react";
import { getSettings, saveSettings } from "../utils/settings";
import "./Settings.css";

interface SettingsProps {
  onBack?: () => void;
  onNavigateToNodes?: () => void;
}

export default function Settings({ onBack, onNavigateToNodes }: SettingsProps) {
  const [nodeUrl, setNodeUrl] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [registries, setRegistries] = useState<string[]>([]);
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const settings = getSettings();
    setNodeUrl(settings.nodeUrl);
    setAuthUrl(settings.authUrl || "");
    setRegistries(settings.registries || []);
  }, []);

  const handleSave = () => {
    try {
      saveSettings({ 
        nodeUrl,
        authUrl: authUrl.trim() || undefined,
        registries: registries.filter(url => url.trim() !== ''),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error("Failed to save settings:", error);
      alert("Failed to save settings");
    }
  };

  const handleAddRegistry = () => {
    if (newRegistryUrl.trim() && !registries.includes(newRegistryUrl.trim())) {
      setRegistries([...registries, newRegistryUrl.trim()]);
      setNewRegistryUrl("");
    }
  };

  const handleRemoveRegistry = (index: number) => {
    setRegistries(registries.filter((_, i) => i !== index));
  };

  return (
    <div className="settings-page">
      <header className="settings-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {onBack && (
            <button onClick={onBack} className="button" style={{ background: '#f0f0f0' }}>
              ← Back
            </button>
          )}
          <h1 style={{ margin: 0 }}>Settings</h1>
        </div>
      </header>

      <main className="settings-main">
        <div className="settings-card">
          <h2>Node Management</h2>
          <p className="field-hint" style={{ marginBottom: '16px' }}>
            Manage merod nodes: create, start, stop, and detect running nodes.
          </p>
          {onNavigateToNodes && (
            <button onClick={onNavigateToNodes} className="button button-primary">
              Open Nodes Page
            </button>
          )}
        </div>

        <div className="settings-card">
          <h2>Node Configuration</h2>
          
          <div className="settings-field">
            <label htmlFor="node-url">Node URL</label>
            <input
              id="node-url"
              type="text"
              value={nodeUrl}
              onChange={(e) => setNodeUrl(e.target.value)}
              placeholder="http://localhost:2528"
            />
            <p className="field-hint">
              Base URL for your merod node. Admin API will be accessed at:{" "}
              <code>{nodeUrl ? `${nodeUrl.replace(/\/$/, '')}/admin-api` : ''}</code>
              <br />
              <strong>HTTP Interception:</strong> When apps are opened in Tauri windows, requests to this URL will be automatically intercepted and proxied through Tauri to bypass mixed content restrictions (for non-HTTPS node URLs).
            </p>
          </div>

          <div className="settings-field">
            <label htmlFor="auth-url">Auth URL (optional)</label>
            <input
              id="auth-url"
              type="text"
              value={authUrl}
              onChange={(e) => setAuthUrl(e.target.value)}
              placeholder="Leave empty to use Node URL"
            />
            <p className="field-hint">
              Base URL for authentication service. If empty, uses Node URL. Auth API will be accessed at:{" "}
              <code>{(authUrl || nodeUrl) ? `${(authUrl || nodeUrl).replace(/\/$/, '')}/auth` : ''}</code>
            </p>
          </div>

          <div className="settings-actions">
            <button onClick={handleSave} className="button button-primary">
              Save Settings
            </button>
            {saved && <span className="saved-indicator">✓ Saved</span>}
          </div>
        </div>

        <div className="settings-card">
          <h2>Application Registries</h2>
          <p className="field-hint" style={{ marginBottom: '16px' }}>
            Configure registry URLs to browse and install applications from the marketplace.
          </p>
          
          <div className="settings-field">
            <label htmlFor="registry-url">Registry URL</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                id="registry-url"
                type="text"
                value={newRegistryUrl}
                onChange={(e) => setNewRegistryUrl(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddRegistry()}
                placeholder="https://registry.calimero.network"
                style={{ flex: 1 }}
              />
              <button 
                onClick={handleAddRegistry}
                className="button"
                disabled={!newRegistryUrl.trim()}
              >
                Add
              </button>
            </div>
          </div>

          {registries.length > 0 && (
            <div className="settings-field">
              <label>Configured Registries</label>
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
                {registries.map((url, index) => (
                  <li 
                    key={index}
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'space-between',
                      padding: '8px',
                      marginBottom: '4px',
                      backgroundColor: '#f5f5f5',
                      borderRadius: '4px'
                    }}
                  >
                    <span>{url}</span>
                    <button
                      onClick={() => handleRemoveRegistry(index)}
                      className="button"
                      style={{ 
                        background: '#ef4444', 
                        color: 'white',
                        padding: '4px 12px',
                        fontSize: '12px'
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="settings-actions">
            <button onClick={handleSave} className="button button-primary">
              Save Settings
            </button>
            {saved && <span className="saved-indicator">✓ Saved</span>}
          </div>
        </div>
      </main>
    </div>
  );
}

