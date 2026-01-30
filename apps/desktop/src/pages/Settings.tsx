import { useState, useEffect } from "react";
import { getSettings, saveSettings, clearAllAppData } from "../utils/settings";
import { invoke } from "@tauri-apps/api/tauri";
import { killAllMerodProcesses, deleteCalimeroDataDir, stopMerod } from "../utils/merod";
import { useTheme } from "../contexts/ThemeContext";
import { useToast } from "../contexts/ToastContext";
import { Check, ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import "./Settings.css";

interface SettingsProps {
  onBack?: () => void;
}

export default function Settings({ onBack }: SettingsProps) {
  const { theme, toggleTheme } = useTheme();
  const toast = useToast();
  const [registries, setRegistries] = useState<string[]>([]);
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  const [saved, setSaved] = useState(false);
  
  // Node management state (removed - now in NodeManagement page)
  const [activeTab, setActiveTab] = useState<'general' | 'registries'>('general');
  const [developerMode, setDeveloperMode] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showNukeConfirm, setShowNukeConfirm] = useState(false);
  const [nukeConfirmed, setNukeConfirmed] = useState(false);
  const [nuking, setNuking] = useState(false);
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [startAtLoginLoading, setStartAtLoginLoading] = useState(true);
  const [startAtLoginAvailable, setStartAtLoginAvailable] = useState(true);

  useEffect(() => {
    const settings = getSettings();
    setRegistries(settings.registries || []);
    setDeveloperMode(settings.developerMode ?? false);
  }, []);

  useEffect(() => {
    invoke<boolean>("autostart_is_enabled")
      .then(setStartAtLogin)
      .catch(() => {
        setStartAtLogin(false);
        setStartAtLoginAvailable(false);
      })
      .finally(() => setStartAtLoginLoading(false));
  }, []);

  const handleStartAtLoginToggle = async () => {
    if (!startAtLoginAvailable) return;
    setStartAtLoginLoading(true);
    try {
      const newValue = !startAtLogin;
      if (newValue) {
        await invoke("autostart_enable");
      } else {
        await invoke("autostart_disable");
      }
      setStartAtLogin(newValue);
      toast.success(newValue ? "App will start at login" : "App will not start at login");
    } catch (err: unknown) {
      toast.error(`Failed to update: ${String(err)}`);
    } finally {
      setStartAtLoginLoading(false);
    }
  };

  const handleDeveloperModeToggle = () => {
    const newValue = !developerMode;
    setDeveloperMode(newValue);
    const settings = getSettings();
    saveSettings({
      ...settings,
      developerMode: newValue,
    });
    toast.success(`Developer mode ${newValue ? 'enabled' : 'disabled'}`);
  };

  const handleSave = () => {
    try {
      const settings = getSettings();
      saveSettings({ 
        ...settings,
        registries: registries.filter(url => url.trim() !== ''),
        developerMode,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success("Settings saved successfully");
    } catch (error) {
      console.error("Failed to save settings:", error);
      toast.error("Failed to save settings");
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
        <div className="settings-header-left">
          {onBack && (
            <button onClick={onBack} className="button button-secondary">
              <ArrowLeft size={16} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
              Back
            </button>
          )}
          <h1>Settings</h1>
        </div>
      </header>

      <main className="settings-main">
        <div className="settings-tabs">
          <button 
            className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            General
          </button>
          <button 
            className={`settings-tab ${activeTab === 'registries' ? 'active' : ''}`}
            onClick={() => setActiveTab('registries')}
          >
            Registries
            </button>
        </div>

        {activeTab === 'general' && (
          <div className="settings-content">
        <div className="settings-card">
              <h2>Startup</h2>
          <div className="settings-field">
                <span className="settings-field-label">Start at login</span>
                <div className="toggle-switch">
            <input
                    id="start-at-login"
                    type="checkbox"
                    checked={startAtLogin}
                    onChange={handleStartAtLoginToggle}
                    disabled={startAtLoginLoading || !startAtLoginAvailable}
                  />
                  <label htmlFor="start-at-login" className="toggle-label">
                    <span className="toggle-slider"></span>
                    <span className="toggle-text">
                      {startAtLoginLoading ? "..." : startAtLogin ? "Enabled" : "Disabled"}
                    </span>
                  </label>
                </div>
                <p className="field-hint">Launch Calimero when you log in. The node will auto-start if configured.</p>
              </div>
          </div>
        <div className="settings-card">
              <h2>Appearance</h2>
          <div className="settings-field">
                <span className="settings-field-label">Dark Mode</span>
                <div className="toggle-switch">
            <input
                    id="theme-toggle"
                    type="checkbox"
                    checked={theme === 'dark'}
                    onChange={() => toggleTheme()}
                  />
                  <label htmlFor="theme-toggle" className="toggle-label">
                    <span className="toggle-slider"></span>
                    <span className="toggle-text">
                      {theme === 'dark' ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                </div>
                <p className="field-hint">Choose between light and dark theme</p>
              </div>
          </div>

            <div className="settings-card">
              <h2>Advanced</h2>
          <div className="settings-field">
                <span className="settings-field-label">Developer Mode</span>
                <div className="toggle-switch">
            <input
                    id="developer-mode"
                    type="checkbox"
                    checked={developerMode}
                    onChange={handleDeveloperModeToggle}
                  />
                  <label htmlFor="developer-mode" className="toggle-label">
                    <span className="toggle-slider"></span>
                    <span className="toggle-text">
                      {developerMode ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                </div>
            <p className="field-hint">
                  Enable to show advanced features like multiple node management and contexts tab.
                  When disabled, the app uses a simplified single-node mode.
            </p>
          </div>
              <div className="settings-field" style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color, #333)' }}>
                <span className="settings-field-label">Reset app</span>
                <p className="field-hint" style={{ marginBottom: '8px' }}>
                  Stop the node, clear all settings and theme, and start from scratch.
                </p>
                {!showResetConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowResetConfirm(true)}
                    className="button button-danger"
                  >
                    <RotateCcw size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                    Reset node and all settings
                  </button>
                ) : (
                  <div className="reset-confirm-form">
                    <p className="reset-confirm-warning">
                      This will stop the node, clear all settings and theme, and reload the app. You will need to set up from scratch.
                    </p>
                    <label className="reset-confirm-checkbox">
                      <input
                        type="checkbox"
                        checked={resetConfirmed}
                        onChange={(e) => setResetConfirmed(e.target.checked)}
                      />
                      <span>I understand this cannot be undone</span>
                    </label>
                    <div className="reset-confirm-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setShowResetConfirm(false);
                          setResetConfirmed(false);
                        }}
                        className="button button-secondary"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!resetConfirmed) return;
                          setResetting(true);
                          try {
                            await stopMerod();
                          } catch {
                            // Node may not be running
                          }
                          clearAllAppData();
                          window.location.reload();
                        }}
                        className="button button-danger"
                        disabled={!resetConfirmed || resetting}
                      >
                        {resetting ? 'Resetting...' : 'Confirm reset'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="settings-field" style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color, #333)' }}>
                <span className="settings-field-label">Total nuke</span>
                <p className="field-hint" style={{ marginBottom: '8px' }}>
                  Permanently delete the data folder (~/.calimero or your configured path), including all nodes, installed apps, and configuration. Then reset the app.
                </p>
                {!showNukeConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowNukeConfirm(true)}
                    className="button button-danger"
                  >
                    <Trash2 size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                    Delete data folder and reset
                  </button>
                ) : (
                  <div className="reset-confirm-form">
                    <p className="reset-confirm-warning">
                      This will permanently delete the data folder and everything in it (nodes, apps, keys). The path to be deleted:
                    </p>
                    <p className="reset-confirm-path">
                      <code>{getSettings().embeddedNodeDataDir || "~/.calimero"}</code>
                    </p>
                    <label className="reset-confirm-checkbox">
                      <input
                        type="checkbox"
                        checked={nukeConfirmed}
                        onChange={(e) => setNukeConfirmed(e.target.checked)}
                      />
                      <span>I understand this will permanently delete all data and cannot be undone</span>
                    </label>
                    <div className="reset-confirm-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setShowNukeConfirm(false);
                          setNukeConfirmed(false);
                        }}
                        className="button button-secondary"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!nukeConfirmed) return;
                          setNuking(true);
                          try {
                            await killAllMerodProcesses();
                          } catch (err: unknown) {
                            toast.error(String(err));
                            setNuking(false);
                            return;
                          }
                          const dataDir = getSettings().embeddedNodeDataDir || "~/.calimero";
                          try {
                            await deleteCalimeroDataDir(dataDir);
                          } catch (err: unknown) {
                            toast.error(String(err));
                            setNuking(false);
                            return;
                          }
                          clearAllAppData();
                          window.location.reload();
                        }}
                        className="button button-danger"
                        disabled={!nukeConfirmed || nuking}
                      >
                        {nuking ? 'Deleting...' : 'Delete everything and reset'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}


        {activeTab === 'registries' && (
          <div className="settings-content">
        <div className="settings-card">
          <h2>Application Registries</h2>
          <p className="field-hint" style={{ marginBottom: '16px' }}>
            Configure registry URLs to browse and install applications from the marketplace.
          </p>
          
          <div className="settings-field">
            <label htmlFor="registry-url">Registry URL</label>
                <div className="input-group">
              <input
                id="registry-url"
                type="text"
                value={newRegistryUrl}
                onChange={(e) => setNewRegistryUrl(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddRegistry()}
                    placeholder="https://apps.calimero.network/"
              />
              <button 
                onClick={handleAddRegistry}
                    className="button button-primary"
                disabled={!newRegistryUrl.trim()}
              >
                Add
              </button>
            </div>
          </div>

          {registries.length > 0 && (
            <div className="settings-field">
              <label>Configured Registries</label>
                  <div className="registry-list">
                {registries.map((url, index) => (
                      <div key={index} className="registry-item">
                        <span className="registry-url">{url}</span>
                    <button
                      onClick={() => handleRemoveRegistry(index)}
                          className="button button-danger"
                    >
                      Remove
                    </button>
                      </div>
                ))}
                  </div>
            </div>
          )}

          <div className="settings-actions">
            <button onClick={handleSave} className="button button-primary">
              Save Settings
            </button>
                {saved && (
                  <span className="saved-indicator">
                    <Check size={14} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                    Saved
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
