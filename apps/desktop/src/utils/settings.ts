export interface AppSettings {
  nodeUrl: string;
}

const SETTINGS_KEY = 'calimero-desktop-settings';
const DEFAULT_NODE_URL = 'http://localhost:2528';

export function getSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        nodeUrl: parsed.nodeUrl || DEFAULT_NODE_URL,
      };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  
  return {
    nodeUrl: DEFAULT_NODE_URL,
  };
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Failed to save settings:', error);
    throw error;
  }
}


