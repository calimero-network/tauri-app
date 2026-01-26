export interface AppSettings {
  nodeUrl: string;
  authUrl?: string; // Optional, defaults to nodeUrl if not set
  registries?: string[]; // Array of registry URLs
  useEmbeddedNode?: boolean; // Use embedded merod node
  embeddedNodePort?: number; // Port for embedded node (default: 2528)
  embeddedNodeDataDir?: string; // Data directory for embedded node (default: ~/.calimero)
  embeddedNodeName?: string; // Node name for embedded node
  developerMode?: boolean; // Developer mode - shows advanced features like multiple nodes and contexts
}

const SETTINGS_KEY = 'calimero-desktop-settings';
const DEFAULT_NODE_URL = 'http://localhost:2528';
const DEFAULT_REGISTRY_URL = 'https://apps.calimero.network/';
const OLD_DEFAULT_REGISTRY_URL = 'http://localhost:8080';

/**
 * Get raw settings without migration (used internally)
 */
function getSettingsRaw(): AppSettings | null {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  return null;
}

/**
 * Migrate old registry URLs to the new default
 */
function migrateRegistries(registries: string[] | undefined, rawSettings: AppSettings | null): string[] {
  if (!registries || registries.length === 0) {
    return [DEFAULT_REGISTRY_URL];
  }

  // Replace old localhost registry with new default
  const migrated = registries.map(url => {
    // Normalize URLs for comparison (remove trailing slashes)
    const normalizedUrl = url.replace(/\/$/, '');
    const normalizedOld = OLD_DEFAULT_REGISTRY_URL.replace(/\/$/, '');
    
    if (normalizedUrl === normalizedOld) {
      return DEFAULT_REGISTRY_URL;
    }
    return url;
  });

  // If we made changes, save them back
  const hasChanges = migrated.some((url, index) => url !== registries[index]);
  if (hasChanges && rawSettings) {
    console.log('Migrating registries from old default to new default');
    saveSettings({
      ...rawSettings,
      registries: migrated,
    });
  }

  return migrated;
}

export function getSettings(): AppSettings {
  try {
    const rawSettings = getSettingsRaw();
    if (rawSettings) {
      const migratedRegistries = migrateRegistries(rawSettings.registries, rawSettings);
      
      return {
        nodeUrl: rawSettings.nodeUrl || DEFAULT_NODE_URL,
        authUrl: rawSettings.authUrl,
        registries: migratedRegistries,
        useEmbeddedNode: rawSettings.useEmbeddedNode,
        embeddedNodePort: rawSettings.embeddedNodePort,
        embeddedNodeDataDir: rawSettings.embeddedNodeDataDir,
        embeddedNodeName: rawSettings.embeddedNodeName,
        developerMode: rawSettings.developerMode ?? false, // Default to false
      };
    }
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
  
  return {
    nodeUrl: DEFAULT_NODE_URL,
    registries: [DEFAULT_REGISTRY_URL], // Default to Calimero apps registry
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


