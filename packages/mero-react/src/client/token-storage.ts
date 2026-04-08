// Token storage utilities - matches calimero-client API
// In Tauri: tokens are stored in the OS keychain (Keychain on macOS,
// Credential Manager on Windows, libsecret on Linux).
// In web / test environments: falls back to localStorage.

const ACCESS_TOKEN_KEY = 'calimero_access_token';
const REFRESH_TOKEN_KEY = 'calimero_refresh_token';
const EXPIRES_AT_KEY = 'calimero_token_expires_at';
const APP_ENDPOINT_KEY = 'calimero_app_endpoint';

// ─── Secure storage primitives ─────────────────────────────────────────────────

// In Tauri 1.x the IPC bridge is window.__TAURI_IPC__. window.__TAURI__ is ALSO
// injected by the webview (but does not expose invoke directly — that's only in
// the npm package). We detect "real Tauri" by requiring BOTH globals:
//   • __TAURI__        — injected by Tauri webview init
//   • __TAURI_IPC__   — the IPC bridge
// Playwright's stubTauriIPC helper only sets __TAURI_IPC__, not __TAURI__,
// so tests transparently fall through to localStorage.

function isTauriEnv(): boolean {
  return (
    typeof window !== 'undefined' &&
    '__TAURI__' in window &&
    typeof (window as any).__TAURI_IPC__ === 'function'
  );
}

/**
 * Minimal inline invoke — mirrors the @tauri-apps/api/tauri implementation so
 * mero-react doesn't need @tauri-apps/api as a dependency.
 */
function tauriInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = window.crypto.getRandomValues(new Uint32Array(1))[0];
    const callbackProp = `_${id}`;

    const errorId = window.crypto.getRandomValues(new Uint32Array(1))[0];
    const errorProp = `_${errorId}`;

    Object.defineProperty(window, callbackProp, {
      value: (result: T) => {
        Reflect.deleteProperty(window, callbackProp);
        Reflect.deleteProperty(window, errorProp);
        resolve(result);
      },
      configurable: true,
      writable: false,
    });
    Object.defineProperty(window, errorProp, {
      value: (err: unknown) => {
        Reflect.deleteProperty(window, callbackProp);
        Reflect.deleteProperty(window, errorProp);
        reject(err);
      },
      configurable: true,
      writable: false,
    });

    (window as any).__TAURI_IPC__({ cmd, callback: id, error: errorId, ...args });
  });
}

async function keychainSet(key: string, value: string): Promise<void> {
  if (isTauriEnv()) {
    try {
      await tauriInvoke('secure_store_token', { key, value });
      return;
    } catch (e) {
      console.warn('[TokenStorage] Keychain write failed, falling back to localStorage:', e);
    }
  }
  localStorage.setItem(key, value);
}

async function keychainGet(key: string): Promise<string | null> {
  if (isTauriEnv()) {
    try {
      return await tauriInvoke<string | null>('secure_get_token', { key });
    } catch (e) {
      console.warn('[TokenStorage] Keychain read failed, falling back to localStorage:', e);
    }
  }
  return localStorage.getItem(key);
}

async function keychainDelete(key: string): Promise<void> {
  if (isTauriEnv()) {
    try {
      await tauriInvoke('secure_delete_token', { key });
    } catch (e) {
      console.warn('[TokenStorage] Keychain delete failed:', e);
    }
  }
  // Always clear localStorage too (handles migration from pre-keychain installs)
  localStorage.removeItem(key);
}

// ─── In-memory cache ────────────────────────────────────────────────────────────
// Lets the existing synchronous API keep working after the first async warm-up.

const cache: Record<string, string | null> = {
  [ACCESS_TOKEN_KEY]: null,
  [REFRESH_TOKEN_KEY]: null,
};

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Warm the in-memory cache from secure storage.
 * Call this once at app startup so subsequent sync reads hit the cache.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initializeTokenStorage(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const [access, refresh] = await Promise.all([
      keychainGet(ACCESS_TOKEN_KEY),
      keychainGet(REFRESH_TOKEN_KEY),
    ]).catch((e) => {
      // Reset so callers can retry on next app interaction
      initPromise = null;
      throw e;
    });
    cache[ACCESS_TOKEN_KEY] = access;
    cache[REFRESH_TOKEN_KEY] = refresh;

    // One-time migration: move tokens that were written to localStorage before
    // this update from localStorage into the keychain.
    if (isTauriEnv()) {
      const localAccess = localStorage.getItem(ACCESS_TOKEN_KEY);
      const localRefresh = localStorage.getItem(REFRESH_TOKEN_KEY);
      if (localAccess && !cache[ACCESS_TOKEN_KEY]) {
        await keychainSet(ACCESS_TOKEN_KEY, localAccess);
        cache[ACCESS_TOKEN_KEY] = localAccess;
        localStorage.removeItem(ACCESS_TOKEN_KEY);
      }
      if (localRefresh && !cache[REFRESH_TOKEN_KEY]) {
        await keychainSet(REFRESH_TOKEN_KEY, localRefresh);
        cache[REFRESH_TOKEN_KEY] = localRefresh;
        localStorage.removeItem(REFRESH_TOKEN_KEY);
      }
    }

    initialized = true;
  })();

  return initPromise;
}

// ─── Access token ───────────────────────────────────────────────────────────────

export function setAccessToken(token: string): void {
  cache[ACCESS_TOKEN_KEY] = token;
  keychainSet(ACCESS_TOKEN_KEY, token).catch(console.error);
}

export function getAccessToken(): string | null {
  if (!initialized && cache[ACCESS_TOKEN_KEY] === null) {
    // Best-effort sync fallback before the async init completes
    const local = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (local) cache[ACCESS_TOKEN_KEY] = local;
    initializeTokenStorage().catch(console.error);
  }
  return cache[ACCESS_TOKEN_KEY];
}

export function clearAccessToken(): void {
  cache[ACCESS_TOKEN_KEY] = null;
  keychainDelete(ACCESS_TOKEN_KEY).catch(console.error);
}

// ─── Refresh token ──────────────────────────────────────────────────────────────

export function setRefreshToken(token: string): void {
  cache[REFRESH_TOKEN_KEY] = token;
  keychainSet(REFRESH_TOKEN_KEY, token).catch(console.error);
}

export function getRefreshToken(): string | null {
  if (!initialized && cache[REFRESH_TOKEN_KEY] === null) {
    const local = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (local) cache[REFRESH_TOKEN_KEY] = local;
    initializeTokenStorage().catch(console.error);
  }
  return cache[REFRESH_TOKEN_KEY];
}

export function clearRefreshToken(): void {
  cache[REFRESH_TOKEN_KEY] = null;
  keychainDelete(REFRESH_TOKEN_KEY).catch(console.error);
}

// ─── Token expiry (not sensitive — stays in localStorage) ──────────────────────

export function setTokenExpiresAt(expiresAt: number): void {
  localStorage.setItem(EXPIRES_AT_KEY, expiresAt.toString());
}

export function getTokenExpiresAt(): number | null {
  const value = localStorage.getItem(EXPIRES_AT_KEY);
  return value ? parseInt(value, 10) : null;
}

export function clearTokenExpiresAt(): void {
  localStorage.removeItem(EXPIRES_AT_KEY);
}

// ─── App endpoint (not sensitive — stays in localStorage) ──────────────────────

export function getAppEndpointKey(): string | null {
  return localStorage.getItem(APP_ENDPOINT_KEY);
}

export function setAppEndpointKey(endpoint: string): void {
  localStorage.setItem(APP_ENDPOINT_KEY, endpoint);
}

export function clearAppEndpointKey(): void {
  localStorage.removeItem(APP_ENDPOINT_KEY);
}

// ─── Bulk clear ─────────────────────────────────────────────────────────────────

export function clearAllTokens(): void {
  clearAccessToken();
  clearRefreshToken();
  clearTokenExpiresAt();
}
