export interface AppSettings {
  nodeUrl: string;
  authUrl?: string; // Optional, defaults to nodeUrl if not set
  registries?: string[]; // Array of registry URLs
}

const SETTINGS_KEY = 'calimero-desktop-settings';
const DEFAULT_NODE_URL = 'http://localhost:2528';
const DEFAULT_REGISTRY_URL = 'http://localhost:8080';

export function getSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        nodeUrl: parsed.nodeUrl || DEFAULT_NODE_URL,
        authUrl: parsed.authUrl,
        registries: parsed.registries && parsed.registries.length > 0 
          ? parsed.registries 
          : [DEFAULT_REGISTRY_URL], // Default to local registry if empty
      };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  
  return {
    nodeUrl: DEFAULT_NODE_URL,
    registries: [DEFAULT_REGISTRY_URL], // Default to local registry for development
  };
}

export function getAuthUrl(settings: AppSettings): string {
  return settings.authUrl || settings.nodeUrl;
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('Failed to save settings:', error);
    throw error;
  }
}


