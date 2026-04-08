import { invoke } from '@tauri-apps/api';
import { getSettings, saveSettings } from './settings';
import { getCloudNode } from './cloudApi';

const CLOUD_LOGIN_URL = 'https://cloud.calimero.network';
const CLOUD_CALLBACK_SCHEME = 'calimero://cloud-callback';
const LOGIN_POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 120_000; // 2 minutes

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
  const loginUrl = `${CLOUD_LOGIN_URL}/?callback-url=${encodeURIComponent(CLOUD_CALLBACK_SCHEME)}`;

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
 * Poll the Tauri backend for a pending cloud auth deep link.
 * The OS launches the app with calimero:// as a CLI arg, which
 * parse_deep_link_arg() catches and stores in PendingCloudAuth state.
 */
async function pollForCloudAuth(): Promise<string | null> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const url = await invoke<string | null>('get_pending_cloud_auth');
      if (url) {
        await invoke('clear_pending_cloud_auth');
        return extractTokenFromCallbackUrl(url);
      }
    } catch {
      // Command not available yet or error — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_INTERVAL_MS));
  }

  return null;
}

/**
 * Extract the id_token from a callback URL like:
 * calimero://cloud-callback#id_token=eyJ...
 */
function extractTokenFromCallbackUrl(url: string): string | null {
  try {
    // The token is in the URL fragment (after #)
    const hashIndex = url.indexOf('#');
    if (hashIndex === -1) return null;

    const fragment = url.substring(hashIndex + 1);
    const params = new URLSearchParams(fragment);
    return params.get('id_token');
  } catch {
    return null;
  }
}

/**
 * Disconnect from Calimero Cloud. Clears all cloud state from settings.
 */
export function disconnectCloud(): void {
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
 * Check if the user has a valid (non-expired) cloud connection.
 */
export function isCloudConnected(): boolean {
  const settings = getSettings();
  if (!settings.cloudConnected || !settings.cloudIdToken) return false;
  return !isTokenExpired(settings.cloudIdToken);
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
