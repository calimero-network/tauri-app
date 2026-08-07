import { clearAllTokens } from '../lib/token-storage';

export interface AppSettings {
  nodeUrl: string;
  authUrl?: string; // Optional, defaults to nodeUrl if not set
  registries?: string[]; // Array of registry URLs
  useEmbeddedNode?: boolean; // Use embedded merod node
  embeddedNodePort?: number; // Port for embedded node (default: DEFAULT_EMBEDDED_NODE_PORT)
  embeddedNodeSwarmPort?: number; // libp2p swarm port for embedded node (default: DEFAULT_EMBEDDED_SWARM_PORT)
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
  mcpAgentClientId?: string; // Client key minted by "Connect AI agent", revoked when the next connect replaces it
  mcpAgentCredentialPath?: string; // Where that credential was written, so the tab can show it again without re-minting
  mcpAgentNodeUrl?: string; // Node the credential was minted for, which nodeUrl may since have moved off
}

const SETTINGS_KEY = 'calimero-desktop-settings';
const DEFAULT_NODE_URL = 'http://localhost:2528';

/** Embedded-node ports. Both are user-configurable in onboarding and persisted here:
 *  the swarm port used to be a hardcoded 2428 at every start site, so a node created
 *  on a different swarm port had its config.toml rewritten back to 2428 on the next
 *  autostart — and anything else holding 2428 made the node unstartable with no way
 *  out from the UI. */
export const DEFAULT_EMBEDDED_NODE_PORT = 2528;
export const DEFAULT_EMBEDDED_SWARM_PORT = 2428;
const DEFAULT_REGISTRY_URL = 'https://apps.calimero.network/';
const OLD_DEFAULT_REGISTRY_URL = 'http://localhost:8080';

function readStored(): string | null {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch (error) {
    console.error('Failed to load settings:', error);
    return null;
  }
}

function parseStored(stored: string | null): AppSettings | null {
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch (error) {
    console.error('Failed to load settings:', error);
    return null;
  }
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
    try {
      saveSettings({
        ...rawSettings,
        registries: migrated,
      });
    } catch {
      // A failed write must not cost the caller its settings. The memo still keys
      // on the unchanged raw string, so a later successful write re-derives.
    }
  }

  return migrated;
}

function buildSettings(rawSettings: AppSettings | null): AppSettings {
  try {
    if (rawSettings) {
      const migratedRegistries = migrateRegistries(rawSettings.registries, rawSettings);

      return {
        nodeUrl: rawSettings.nodeUrl || DEFAULT_NODE_URL,
        authUrl: rawSettings.authUrl,
        registries: migratedRegistries,
        useEmbeddedNode: rawSettings.useEmbeddedNode,
        embeddedNodePort: rawSettings.embeddedNodePort,
        embeddedNodeSwarmPort: rawSettings.embeddedNodeSwarmPort,
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
        mcpAgentClientId: rawSettings.mcpAgentClientId,
        mcpAgentCredentialPath: rawSettings.mcpAgentCredentialPath,
        mcpAgentNodeUrl: rawSettings.mcpAgentNodeUrl,
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

let cachedStored: string | null = null;
let cachedSettings: AppSettings | null = null;

/**
 * Parsed settings. Called dozens of times per render pass, so the result is
 * memoised on the raw stored string: any write invalidates it, ours or not.
 * The returned object is shared and frozen - spread it to derive a new one.
 */
export function getSettings(): AppSettings {
  const stored = readStored();
  if (cachedSettings && stored === cachedStored) return cachedSettings;

  const built = buildSettings(parseStored(stored));
  // Freeze one level down too: the shared registries array is the mutation
  // callers would otherwise reach for.
  Object.freeze(built.registries);
  const settings = Object.freeze(built);
  // Re-read: the registry migration writes back while we build.
  cachedStored = readStored();
  cachedSettings = settings;
  return settings;
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

/**
 * Clear all app data for this origin: settings, theme, onboarding progress, caches,
 * session tokens, context keys, pending OAuth state — everything.
 * Use with stopMerod() for full reset. Caller should reload the app after this.
 *
 * Deliberately `clear()` rather than an allowlist of keys: the allowlist version of
 * this function silently missed every key added after it was written (context keys,
 * the pending OAuth nonce), so a "reset" kept state it promised to delete. Nothing
 * in this origin's localStorage is worth preserving across a reset.
 *
 * Note: localStorage is partitioned per web origin, so this only clears the silo of the
 * origin it runs in. Loaded app UIs served from other origins (each node URL is a distinct
 * origin) keep their own tokens — wiping those needs the `clear_app_sessions` command,
 * which clears the webview's on-disk website data. See utils/hardReset.ts.
 */
export function clearAllAppData(): void {
  clearAllTokens();
  localStorage.clear();
  sessionStorage.clear();
}


