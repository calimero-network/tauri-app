import { useState, useEffect } from "react";
import { getSettings, saveSettings } from "../utils/settings";
import { useTheme } from "../contexts/ThemeContext";
import { useToast } from "../contexts/ToastContext";
import { Check, ArrowLeft } from "lucide-react";
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

  useEffect(() => {
    const settings = getSettings();
    setRegistries(settings.registries || []);
    setDeveloperMode(settings.developerMode ?? false);
  }, []);

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
