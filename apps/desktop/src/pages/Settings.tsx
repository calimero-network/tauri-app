import { useState, useEffect } from "react";
import { getSettings, saveSettings } from "../utils/settings";
import "./Settings.css";

interface SettingsProps {
  onBack?: () => void;
}

export default function Settings({ onBack }: SettingsProps) {
  const [nodeUrl, setNodeUrl] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const settings = getSettings();
    setNodeUrl(settings.nodeUrl);
  }, []);

  const handleSave = () => {
    try {
      saveSettings({ nodeUrl });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      console.error("Failed to save settings:", error);
      alert("Failed to save settings");
    }
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
            </p>
          </div>

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

