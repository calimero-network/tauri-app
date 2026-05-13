import { invoke } from '@tauri-apps/api';
import { listen } from '@tauri-apps/api/event';
import { getSettings, saveSettings } from './settings';
import { getCloudNode } from './cloudApi';

const CLOUD_LOGIN_URL = 'https://cloud.calimero.network';
const CLOUD_CALLBACK_SCHEME = 'calimero://cloud-callback';
const LOGIN_POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes

// OAuth CSRF state — rotated per startCloudLogin() call and checked when
// the deep link arrives. Blocks forged calimero:// callbacks.
//
// Persisted to localStorage instead of a module variable so it survives the
// "cold-launch" case: if the user closes the app between clicking "Connect
// Cloud" and the browser redirecting back via calimero://, the OS launches
// a *new* process to handle the URL. A module-level variable would be null
// in that fresh process and state validation would always fail closed —
// correct security posture but a silent UX dead-end for a common flow.
// localStorage survives process restart, so the new process can still
// verify the nonce the old one generated.
//
// TTL guards against stale nonces from abandoned login attempts (10 min is
// longer than any plausible interactive Google sign-in). Each new
// startCloudLogin() overwrites the previous record; rapid repeat clicks
// therefore invalidate earlier callbacks, which is the intended behavior.
const OAUTH_STATE_KEY = 'calimero_oauth_pending_state';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingOAuthState {
  state: string;
  expiresAt: number;
}

function generateState(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

function savePendingState(state: string): void {
  try {
    const record: PendingOAuthState = {
      state,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    };
    localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(record));
  } catch {
    // localStorage unavailable — CSRF check will fail closed on the
    // callback side, which is safer than silently succeeding.
  }
}

function consumePendingState(): string | null {
  try {
    const raw = localStorage.getItem(OAUTH_STATE_KEY);
    if (!raw) return null;
    // Clear immediately so the nonce cannot be replayed by a second
    // callback (e.g. a slow redirect racing with a retry).
    localStorage.removeItem(OAUTH_STATE_KEY);
    const record = JSON.parse(raw) as Partial<PendingOAuthState>;
    if (!record || typeof record.state !== 'string' || typeof record.expiresAt !== 'number') {
      return null;
    }
    if (Date.now() > record.expiresAt) return null;
    return record.state;
  } catch {
    return null;
  }
}

function clearPendingState(): void {
  try {
    localStorage.removeItem(OAUTH_STATE_KEY);
  } catch {
    // Ignore — same rationale as savePendingState's silent failure.
  }
}

export interface CloudUserInfo {
  email: string;
  name: string;
  picture: string;
}

/**
 * Decode a Google ID token JWT to extract user claims.
 * No signature verification — the Cloud API server handles that.
 */
export function decodeIdToken(token: string): CloudUserInfo | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      email: payload.email ?? '',
      name: payload.name ?? '',
      picture: payload.picture ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Check if a Google ID token has expired.
 */
export function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return true;
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

/**
 * Start the Cloud login flow:
 * 1. Open cloud portal in system browser with callback-url param
 * 2. Poll for deep link callback with the ID token
 * 3. Auto-register by calling GET /api/cloud/me/node
 * 4. Store credentials in settings
 */
export async function startCloudLogin(): Promise<CloudUserInfo | null> {
  const state = generateState();
  savePendingState(state);
  const callback = `${CLOUD_CALLBACK_SCHEME}?state=${state}`;
  const loginUrl = `${CLOUD_LOGIN_URL}/?callback-url=${encodeURIComponent(callback)}`;

  // Clear any stale pending auth
  await invoke('clear_pending_cloud_auth');

  // Open cloud portal in system browser
  await invoke('open_url_in_browser', { url: loginUrl });

  // Poll for the deep link callback
  const token = await pollForCloudAuth();
  if (!token) return null;

  // Decode user info from token
  const userInfo = decodeIdToken(token);
  if (!userInfo) return null;

  // Auto-register by fetching cloud node (creates account on first call)
  await getCloudNode(token).catch(() => null);

  // Save to settings
  const settings = getSettings();
  saveSettings({
    ...settings,
    cloudConnected: true,
    cloudIdToken: token,
    cloudUserEmail: userInfo.email,
    cloudUserName: userInfo.name,
    cloudUserPicture: userInfo.picture,
  });

  return userInfo;
}

/**
 * Wait for the deep-link callback via two channels:
 *   - `cloud-auth-callback` Tauri event (hot-launch case: app already running,
 *     the deep-link plugin forwards the URL from the OS handler)
 *   - Polling `get_pending_cloud_auth` (cold-launch case: OS launched the
 *     app with the URL in argv before any listener was set up)
 */
async function pollForCloudAuth(): Promise<string | null> {
  return new Promise<string | null>(async (resolve) => {
    let resolved = false;
    const finish = (token: string | null) => {
      if (resolved) return;
      resolved = true;
      if (unlisten) unlisten();
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolve(token);
    };

    const unlisten = await listen<string>('cloud-auth-callback', (event) => {
      const token = extractTokenFromCallbackUrl(event.payload);
      if (token) finish(token);
    }).catch(() => null);

    const pollTimer = setInterval(async () => {
      try {
        const url = await invoke<string | null>('get_pending_cloud_auth');
        if (url) {
          await invoke('clear_pending_cloud_auth');
          const token = extractTokenFromCallbackUrl(url);
          if (token) finish(token);
        }
      } catch {
        // Command not available yet or error — keep polling
      }
    }, LOGIN_POLL_INTERVAL_MS);

    const timeoutTimer = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
  });
}

/**
 * Extract the id_token from a callback URL like:
 * calimero://cloud-callback?state=ABC#id_token=eyJ...
 *
 * Validates the state param against the nonce we generated when starting
 * the flow — rejects the token on mismatch to block forged callbacks.
 */
function extractTokenFromCallbackUrl(url: string): string | null {
  try {
    const hashIndex = url.indexOf('#');
    const fragment = hashIndex === -1 ? '' : url.substring(hashIndex + 1);
    const queryIndex = url.indexOf('?');
    const queryEnd = hashIndex === -1 ? url.length : hashIndex;
    const query = queryIndex === -1 || queryIndex >= queryEnd
      ? ''
      : url.substring(queryIndex + 1, queryEnd);

    // `consumePendingState` atomically reads and clears the nonce, so it
    // cannot be replayed by a second callback that arrives after the first.
    const expected = consumePendingState();
    const got = query ? new URLSearchParams(query).get('state') : null;
    if (!expected || got !== expected) return null;

    if (!fragment) return null;
    return new URLSearchParams(fragment).get('id_token');
  } catch {
    return null;
  }
}

/**
 * Disconnect from Calimero Cloud. Clears all cloud state from settings.
 */
export function disconnectCloud(): void {
  clearPendingState();
  const settings = getSettings();
  saveSettings({
    ...settings,
    cloudConnected: false,
    cloudIdToken: undefined,
    cloudUserEmail: undefined,
    cloudUserName: undefined,
    cloudUserPicture: undefined,
  });
}

/**
 * Get the stored cloud ID token if valid, or null if expired/missing.
 */
export function getCloudIdToken(): string | null {
  const settings = getSettings();
  if (!settings.cloudIdToken) return null;
  if (isTokenExpired(settings.cloudIdToken)) return null;
  return settings.cloudIdToken;
}
