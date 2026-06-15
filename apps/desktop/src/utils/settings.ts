import { clearAllTokens } from '../lib/token-storage';

export interface AppSettings {
  nodeUrl: string;
  authUrl?: string; // Optional, defaults to nodeUrl if not set
  registries?: string[]; // Array of registry URLs
  useEmbeddedNode?: boolean; // Use embedded merod node
  embeddedNodePort?: number; // Port for embedded node (default: 2528)
  embeddedNodeDataDir?: string; // Data directory for embedded node (default: ~/.calimero)
  embeddedNodeName?: string; // Node name for embedded node
  developerMode?: boolean; // Developer mode - shows advanced features like multiple nodes and contexts
  debugLogs?: boolean; // Enable debug-level logging for the merod node
  cloudEnabled?: boolean; // Runtime override for the cloud feature flag. undefined = use build-time default (VITE_ENABLE_CLOUD / DEV)
  onboardingCompleted?: boolean; // True once user has completed first-time setup - never show onboarding again
  cloudConnected?: boolean; // Whether user is connected to Calimero Cloud
  cloudIdToken?: string; // MDMA session token for Cloud API auth (7d TTL, rolling refresh). During the migration window may hold a Google ID token until exchange lands.
  cloudUserEmail?: string; // User's Google email (for display)
  cloudUserName?: string; // User's Google display name
  cloudUserPicture?: string; // User's Google profile picture URL
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
        debugLogs: rawSettings.debugLogs ?? false,
        cloudEnabled: rawSettings.cloudEnabled, // Passthrough: keep undefined when unset so featureFlags can fall back to build-time default

        onboardingCompleted: rawSettings.onboardingCompleted ?? false,
        cloudConnected: rawSettings.cloudConnected ?? false,
        cloudIdToken: rawSettings.cloudIdToken,
        cloudUserEmail: rawSettings.cloudUserEmail,
        cloudUserName: rawSettings.cloudUserName,
        cloudUserPicture: rawSettings.cloudUserPicture,
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

/**
 * Clear app settings. Use to reset onboarding and start from scratch.
 * Caller should reload the app after this.
 */
export function clearSettings(): void {
  localStorage.removeItem(SETTINGS_KEY);
}

const THEME_KEY = 'calimero-desktop-theme';

/**
 * Clear all app data (settings + theme + onboarding progress + cache + session tokens).
 * Use with stopMerod() for full reset. Caller should reload the app after this.
 *
 * Note: localStorage is partitioned per web origin, so this only clears the silo of the
 * origin it runs in. Loaded app UIs served from other origins (each node URL is a distinct
 * origin) keep their own tokens — wiping those requires clearing WebsiteData on disk.
 */
export function clearAllAppData(): void {
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(THEME_KEY);
  localStorage.removeItem('calimero-onboarding-progress');
  localStorage.removeItem('calimero-autostart-default-applied');
  localStorage.removeItem('calimero-marketplace-cache');
  localStorage.removeItem('calimero-error-log');
  // Session tokens were left behind on reset, so a "reset" still resumed the old
  // authenticated session against the node. Clear them too.
  localStorage.removeItem('calimero-auth-tokens');
  clearAllTokens();
}


