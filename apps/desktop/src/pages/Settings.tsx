import { useState, useEffect } from "react";
import { getSettings, saveSettings, clearAllAppData } from "../utils/settings";
import { parseTauriError } from "../utils/appUtils";
import { invoke } from "@tauri-apps/api/tauri";
import { killAllMerodProcesses, deleteCalimeroDataDir, stopMerod, getMerodStatus } from "../utils/merod";
import { startCloudLogin, disconnectCloud } from "../utils/cloudAuth";
import { getCloudSubscription, CloudSessionExpiredError } from "../utils/cloudApi";
import { isCloudEnabled, notifyCloudEnabledChanged } from "../utils/featureFlags";
import { useTheme } from "../contexts/ThemeContext";
import { useToast } from "../contexts/ToastContext";
import { ArrowLeft, RotateCcw, Trash2, Cloud } from "lucide-react";
import "./Settings.css";

interface SettingsProps {
  onBack?: () => void;
}

export default function Settings({ onBack }: SettingsProps) {
  const { theme, toggleTheme } = useTheme();
  const toast = useToast();
  const [registries, setRegistries] = useState<string[]>([]);
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  
  // Node management state (removed - now in NodeManagement page)
  const [activeTab, setActiveTab] = useState<'general' | 'registries' | 'cloud'>('general');
  const [developerMode, setDeveloperMode] = useState(false);
  const [debugLogs, setDebugLogs] = useState(false);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [cloudConnected, setCloudConnected] = useState(false);
  const [cloudEmail, setCloudEmail] = useState<string | undefined>();
  const [cloudName, setCloudName] = useState<string | undefined>();
  const [cloudPicture, setCloudPicture] = useState<string | undefined>();
  const [cloudPlan, setCloudPlan] = useState<string | undefined>();
  const [cloudLoading, setCloudLoading] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showNukeConfirm, setShowNukeConfirm] = useState(false);
  const [nukeConfirmed, setNukeConfirmed] = useState(false);
  const [nuking, setNuking] = useState(false);
  const [nukeStatus, setNukeStatus] = useState('');
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [startAtLoginLoading, setStartAtLoginLoading] = useState(true);
  const [startAtLoginAvailable, setStartAtLoginAvailable] = useState(true);

  useEffect(() => {
    const settings = getSettings();
    setRegistries(settings.registries || []);
    setDeveloperMode(settings.developerMode ?? false);
    setDebugLogs(settings.debugLogs ?? false);
    // Effective cloud flag: explicit runtime override if set, else the build-time default.
    setCloudEnabled(typeof settings.cloudEnabled === 'boolean' ? settings.cloudEnabled : isCloudEnabled());
    setCloudConnected(settings.cloudConnected ?? false);
    setCloudEmail(settings.cloudUserEmail);
    setCloudName(settings.cloudUserName);
    setCloudPicture(settings.cloudUserPicture);

    // Fetch cloud plan if connected
    if (settings.cloudConnected && settings.cloudIdToken) {
      getCloudSubscription(settings.cloudIdToken)
        .then((sub) => { if (sub) setCloudPlan(sub.plan); })
        .catch((err) => {
          if (err instanceof CloudSessionExpiredError) {
            // Persist the disconnect so stale credentials are cleared.
            disconnectCloud();
            setCloudConnected(false);
            setCloudEmail(undefined);
            setCloudName(undefined);
            setCloudPicture(undefined);
            setCloudPlan(undefined);
          }
        });
    }
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
      toast.error(`Failed to update: ${parseTauriError(err)}`);
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

  const handleDebugLogsToggle = () => {
    const newValue = !debugLogs;
    setDebugLogs(newValue);
    const settings = getSettings();
    saveSettings({
      ...settings,
      debugLogs: newValue,
    });
    toast.success(`Debug logs ${newValue ? 'enabled' : 'disabled'}. Restart the node for changes to take effect.`);
  };

  const handleCloudEnabledToggle = () => {
    const newValue = !cloudEnabled;
    setCloudEnabled(newValue);
    const settings = getSettings();
    saveSettings({
      ...settings,
      cloudEnabled: newValue,
    });
    notifyCloudEnabledChanged();
    toast.success(`Calimero Cloud ${newValue ? 'enabled' : 'disabled'}`);
  };

  const handleAddRegistry = () => {
    const url = newRegistryUrl.trim();
    if (url && !registries.includes(url)) {
      const updated = [...registries, url];
      setRegistries(updated);
      setNewRegistryUrl("");
      // Auto-save so the new registry persists immediately
      const settings = getSettings();
      saveSettings({ ...settings, registries: updated });
      toast.success("Registry added");
    }
  };

  const handleRemoveRegistry = (index: number) => {
    const updated = registries.filter((_, i) => i !== index);
    setRegistries(updated);
    // Auto-save so the removal persists immediately
    const settings = getSettings();
    saveSettings({ ...settings, registries: updated });
    toast.success("Registry removed");
  };


  return (
    <div className="settings-page">
      <header className="settings-header">
        <div className="settings-header-left">
          {onBack && (
            <button onClick={onBack} className="settings-back-btn">
              <ArrowLeft size={16} />
              Back
            </button>
          )}
        </div>
      </header>

      <main className="settings-main">
        <h1 className="settings-title">Settings</h1>
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
          {isCloudEnabled() && (
            <button
              className={`settings-tab ${activeTab === 'cloud' ? 'active' : ''}`}
              onClick={() => setActiveTab('cloud')}
            >
              <Cloud size={14} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
              Cloud
            </button>
          )}
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
          <div className="settings-field">
                <span className="settings-field-label">Debug Logs</span>
                <div className="toggle-switch">
            <input
                    id="debug-logs"
                    type="checkbox"
                    checked={debugLogs}
                    onChange={handleDebugLogsToggle}
                  />
                  <label htmlFor="debug-logs" className="toggle-label">
                    <span className="toggle-slider"></span>
                    <span className="toggle-text">
                      {debugLogs ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                </div>
            <p className="field-hint">
                  Enable debug-level logging for the merod node. Produces more verbose logs useful for troubleshooting.
                  Restart the node for changes to take effect.
            </p>
          </div>
          <div className="settings-field">
                <span className="settings-field-label">Enable Cloud</span>
                <div className="toggle-switch">
            <input
                    id="cloud-enabled"
                    type="checkbox"
                    checked={cloudEnabled}
                    onChange={handleCloudEnabledToggle}
                  />
                  <label htmlFor="cloud-enabled" className="toggle-label">
                    <span className="toggle-slider"></span>
                    <span className="toggle-text">
                      {cloudEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </label>
                </div>
            <p className="field-hint">
                  Show Calimero Cloud sign-in and High Availability features. Takes effect immediately.
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
                            // not running — ok
                          }
                          try {
                            await killAllMerodProcesses();
                          } catch {
                            // best-effort
                          }
                          // Brief settle so OS releases file handles before reload
                          await new Promise((r) => setTimeout(r, 500));
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

                          // Step 1: graceful stop of the embedded node
                          setNukeStatus('Stopping nodes...');
                          try {
                            await stopMerod();
                          } catch {
                            // not running — ok
                          }

                          // Step 2: force-kill any remaining merod processes
                          try {
                            await killAllMerodProcesses();
                          } catch (err: unknown) {
                            toast.error(parseTauriError(err));
                            setNuking(false);
                            setNukeStatus('');
                            return;
                          }

                          // Step 3: wait until the embedded node reports stopped (max 10s)
                          setNukeStatus('Waiting for nodes to stop...');
                          const deadline = Date.now() + 10_000;
                          while (Date.now() < deadline) {
                            try {
                              const status = await getMerodStatus();
                              if (!status.running) break;
                            } catch {
                              break; // process gone — treat as stopped
                            }
                            await new Promise((r) => setTimeout(r, 500));
                          }

                          // Step 4: brief OS-level settle so file handles are released
                          await new Promise((r) => setTimeout(r, 500));

                          // Step 5: delete both the settings path and default ~/.calimero.
                          // After clearAllAppData(), onboarding uses ~/.calimero, so we must remove it.
                          setNukeStatus('Deleting...');
                          const settingsDataDir = getSettings().embeddedNodeDataDir || "~/.calimero";
                          const defaultDataDir = "~/.calimero";
                          const dirsToDelete = [...new Set([settingsDataDir, defaultDataDir])];
                          try {
                            for (const dir of dirsToDelete) {
                              await deleteCalimeroDataDir(dir);
                            }
                          } catch (err: unknown) {
                            toast.error(parseTauriError(err));
                            setNuking(false);
                            setNukeStatus('');
                            return;
                          }

                          clearAllAppData();
                          window.location.reload();
                        }}
                        className="button button-danger"
                        disabled={!nukeConfirmed || nuking}
                      >
                        {nuking ? (nukeStatus || 'Deleting...') : 'Delete everything and reset'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}


        {isCloudEnabled() && activeTab === 'cloud' && (
          <div className="settings-content">
            <div className="settings-card">
              <h2>Calimero Cloud</h2>
              {!cloudConnected ? (
                <>
                  <p className="field-hint" style={{ marginBottom: '16px' }}>
                    Connect to Calimero Cloud for cloud-hosted contexts, High Availability replication,
                    and managed infrastructure. Your local node stays primary — cloud features are additive.
                  </p>
                  <button
                    className="google-signin-btn"
                    onClick={async () => {
                      setCloudLoading(true);
                      try {
                        const userInfo = await startCloudLogin();
                        if (userInfo) {
                          setCloudConnected(true);
                          setCloudEmail(userInfo.email);
                          setCloudName(userInfo.name);
                          setCloudPicture(userInfo.picture);
                          toast.success('Connected to Calimero Cloud');
                          // Fetch plan
                          const settings = getSettings();
                          if (settings.cloudIdToken) {
                            const sub = await getCloudSubscription(settings.cloudIdToken).catch(() => null);
                            if (sub) setCloudPlan(sub.plan);
                          }
                        } else {
                          toast.error('Cloud login timed out or was cancelled');
                        }
                      } catch (err: unknown) {
                        toast.error(`Cloud login failed: ${String(err)}`);
                      } finally {
                        setCloudLoading(false);
                      }
                    }}
                    disabled={cloudLoading}
                  >
                    {!cloudLoading && (
                      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
                        <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                        <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                        <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                      </svg>
                    )}
                    {cloudLoading ? 'Waiting for sign-in…' : 'Sign in with Google'}
                  </button>
                  <p className="field-hint" style={{ marginTop: '12px', fontStyle: 'italic' }}>
                    Your data stays on your device. Cloud features are optional.
                  </p>
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    {cloudPicture && (
                      <img
                        src={cloudPicture}
                        alt=""
                        style={{ width: 40, height: 40, borderRadius: '50%' }}
                      />
                    )}
                    <div>
                      <div style={{ fontWeight: 600 }}>{cloudName || 'Connected'}</div>
                      <div style={{ fontSize: '0.85rem', opacity: 0.7 }}>{cloudEmail}</div>
                    </div>
                    {cloudPlan && (
                      <span style={{
                        marginLeft: 'auto',
                        padding: '2px 10px',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        textTransform: 'capitalize',
                        background: 'var(--accent-bg, #1a3a1a)',
                        color: 'var(--accent-color, #4ade80)',
                        border: '1px solid var(--accent-border, #2d5a2d)',
                      }}>
                        {cloudPlan} plan
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="button button-secondary"
                      onClick={() => invoke('open_url_in_browser', { url: 'https://cloud.calimero.network' })}
                    >
                      Manage on cloud.calimero.network
                    </button>
                    <button
                      className="button button-danger"
                      onClick={() => {
                        disconnectCloud();
                        setCloudConnected(false);
                        setCloudEmail(undefined);
                        setCloudName(undefined);
                        setCloudPicture(undefined);
                        setCloudPlan(undefined);
                        toast.success('Disconnected from Calimero Cloud');
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                </>
              )}
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

          <p className="field-hint" style={{ marginTop: '8px', fontStyle: 'italic' }}>
            Changes are saved automatically.
          </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
