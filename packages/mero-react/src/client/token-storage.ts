// Token storage utilities - matches calimero-client API
// Implements secure token storage using OS keychain (via Tauri) with localStorage fallback

const ACCESS_TOKEN_KEY = 'calimero_access_token';
const REFRESH_TOKEN_KEY = 'calimero_refresh_token';
const APP_ENDPOINT_KEY = 'calimero_app_endpoint';

// Cache for tokens to allow synchronous access after async initialization
// This enables backward compatibility with existing sync API consumers
const tokenCache: Record<string, string | null> = {
  [ACCESS_TOKEN_KEY]: null,
  [REFRESH_TOKEN_KEY]: null,
  [APP_ENDPOINT_KEY]: null,
};

// Track whether we've initialized from secure storage
let isInitialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Check if we're running in a Tauri environment with secure storage available
 */
function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Get the Tauri invoke function if available
 */
async function getTauriInvoke(): Promise<((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null> {
  if (!isTauriEnvironment()) {
    return null;
  }
  try {
    // Dynamic import to avoid bundling Tauri API in non-Tauri environments
    const { invoke } = await import('@tauri-apps/api/tauri');
    return invoke;
  } catch {
    return null;
  }
}

/**
 * Store a token securely using OS keychain (Tauri) or localStorage (fallback)
 */
async function secureStore(key: string, value: string): Promise<void> {
  // Update cache immediately for sync access
  tokenCache[key] = value;
  
  const invoke = await getTauriInvoke();
  if (invoke) {
    try {
      await invoke('secure_store_token', { key, value });
      return;
    } catch (error) {
      console.warn('[TokenStorage] Secure storage failed, using localStorage fallback:', error);
    }
  }
  
  // Fallback to localStorage
  localStorage.setItem(key, value);
}

/**
 * Retrieve a token from secure storage (Tauri) or localStorage (fallback)
 */
async function secureGet(key: string): Promise<string | null> {
  const invoke = await getTauriInvoke();
  if (invoke) {
    try {
      const value = await invoke('secure_get_token', { key }) as string | null;
      tokenCache[key] = value;
      return value;
    } catch (error) {
      console.warn('[TokenStorage] Secure retrieval failed, using localStorage fallback:', error);
    }
  }
  
  // Fallback to localStorage
  const value = localStorage.getItem(key);
  tokenCache[key] = value;
  return value;
}

/**
 * Delete a token from secure storage (Tauri) and localStorage
 */
async function secureDelete(key: string): Promise<void> {
  // Clear cache immediately
  tokenCache[key] = null;
  
  const invoke = await getTauriInvoke();
  if (invoke) {
    try {
      await invoke('secure_delete_token', { key });
    } catch (error) {
      console.warn('[TokenStorage] Secure deletion failed:', error);
    }
  }
  
  // Always clear localStorage too (for migration cleanup)
  localStorage.removeItem(key);
}

/**
 * Initialize token cache from secure storage
 * Call this early in app startup for best performance
 */
export async function initializeTokenStorage(): Promise<void> {
  if (isInitialized) return;
  if (initPromise) return initPromise;
  
  initPromise = (async () => {
    // Load tokens from secure storage into cache
    await Promise.all([
      secureGet(ACCESS_TOKEN_KEY),
      secureGet(REFRESH_TOKEN_KEY),
      secureGet(APP_ENDPOINT_KEY),
    ]);
    
    // Migrate existing localStorage tokens to secure storage if in Tauri
    if (isTauriEnvironment()) {
      const localAccessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
      const localRefreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
      
      // If we have tokens in localStorage but not in secure storage, migrate them
      if (localAccessToken && !tokenCache[ACCESS_TOKEN_KEY]) {
        await secureStore(ACCESS_TOKEN_KEY, localAccessToken);
        localStorage.removeItem(ACCESS_TOKEN_KEY);
      }
      if (localRefreshToken && !tokenCache[REFRESH_TOKEN_KEY]) {
        await secureStore(REFRESH_TOKEN_KEY, localRefreshToken);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
      }
    }
    
    isInitialized = true;
  })();
  
  return initPromise;
}

// ================================
// Public API - Async versions (preferred)
// ================================

export async function setAccessTokenAsync(token: string): Promise<void> {
  await secureStore(ACCESS_TOKEN_KEY, token);
}

export async function getAccessTokenAsync(): Promise<string | null> {
  if (!isInitialized) {
    await initializeTokenStorage();
  }
  return tokenCache[ACCESS_TOKEN_KEY];
}

export async function clearAccessTokenAsync(): Promise<void> {
  await secureDelete(ACCESS_TOKEN_KEY);
}

export async function setRefreshTokenAsync(token: string): Promise<void> {
  await secureStore(REFRESH_TOKEN_KEY, token);
}

export async function getRefreshTokenAsync(): Promise<string | null> {
  if (!isInitialized) {
    await initializeTokenStorage();
  }
  return tokenCache[REFRESH_TOKEN_KEY];
}

export async function clearRefreshTokenAsync(): Promise<void> {
  await secureDelete(REFRESH_TOKEN_KEY);
}

// ================================
// Public API - Sync versions (backward compatibility)
// ================================
// These work with the cache for immediate access.
// Writes trigger async secure storage in the background.

export function setAccessToken(token: string): void {
  tokenCache[ACCESS_TOKEN_KEY] = token;
  // Fire and forget - store securely in background
  secureStore(ACCESS_TOKEN_KEY, token).catch(console.error);
}

export function getAccessToken(): string | null {
  // If not initialized, try to read from localStorage for immediate response
  if (!isInitialized && tokenCache[ACCESS_TOKEN_KEY] === null) {
    const localValue = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (localValue) {
      tokenCache[ACCESS_TOKEN_KEY] = localValue;
    }
    // Trigger async initialization
    initializeTokenStorage().catch(console.error);
  }
  return tokenCache[ACCESS_TOKEN_KEY];
}

export function clearAccessToken(): void {
  tokenCache[ACCESS_TOKEN_KEY] = null;
  // Fire and forget - delete securely in background
  secureDelete(ACCESS_TOKEN_KEY).catch(console.error);
}

export function setRefreshToken(token: string): void {
  tokenCache[REFRESH_TOKEN_KEY] = token;
  // Fire and forget - store securely in background
  secureStore(REFRESH_TOKEN_KEY, token).catch(console.error);
}

export function getRefreshToken(): string | null {
  // If not initialized, try to read from localStorage for immediate response
  if (!isInitialized && tokenCache[REFRESH_TOKEN_KEY] === null) {
    const localValue = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (localValue) {
      tokenCache[REFRESH_TOKEN_KEY] = localValue;
    }
    // Trigger async initialization
    initializeTokenStorage().catch(console.error);
  }
  return tokenCache[REFRESH_TOKEN_KEY];
}

export function clearRefreshToken(): void {
  tokenCache[REFRESH_TOKEN_KEY] = null;
  // Fire and forget - delete securely in background
  secureDelete(REFRESH_TOKEN_KEY).catch(console.error);
}

// App endpoint doesn't contain sensitive data, but we keep consistent API
export function getAppEndpointKey(): string | null {
  return localStorage.getItem(APP_ENDPOINT_KEY);
}

export function setAppEndpointKey(endpoint: string): void {
  localStorage.setItem(APP_ENDPOINT_KEY, endpoint);
}

export function clearAppEndpointKey(): void {
  localStorage.removeItem(APP_ENDPOINT_KEY);
}

