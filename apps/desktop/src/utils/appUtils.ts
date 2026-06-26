import { invoke } from "@tauri-apps/api/tauri";
import { WebviewWindow } from "@tauri-apps/api/window";
import { getSettings } from "./settings";
import { getAccessToken, getRefreshToken, getTokenExpiresAt } from "../lib/token-storage";

/**
 * Extract a human-readable message from a Tauri command error.
 * Tauri commands returning Result<T, TauriError> throw a plain object
 * { code, message, details? } on failure — not an Error instance.
 */
export function parseTauriError(err: unknown, fallback = 'An unexpected error occurred'): string {
  if (err instanceof Error) return err.message;
  if (err != null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
  }
  if (typeof err === 'string') return err;
  return fallback;
}

/**
 * Decodes app metadata from various formats (base64 string, byte array, or already decoded object)
 * @param metadata - The metadata to decode (can be string, number[], or already decoded object)
 * @returns The decoded metadata object, or null if decoding fails
 */
export function decodeMetadata(metadata: any): any {
  if (!metadata) return null;
  
  // If already an object, return as-is
  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata;
  }
  
  try {
    let jsonString: string;
    
    if (typeof metadata === 'string') {
      // base64 → bytes → UTF-8 string (avoids mojibake from Latin-1 atob)
      const binary = atob(metadata);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      jsonString = new TextDecoder('utf-8').decode(bytes);
    } else if (Array.isArray(metadata)) {
      // byte array → UTF-8 string (fixes garbled multi-byte chars like em-dash)
      jsonString = new TextDecoder('utf-8').decode(new Uint8Array(metadata));
    } else {
      // Unknown format, return null
      return null;
    }
    
    return JSON.parse(jsonString);
  } catch (error) {
    console.warn("Failed to decode metadata:", error);
    return null;
  }
}

/**
 * Opens an app frontend in a new Tauri window
 * @param frontendUrl - The URL of the frontend to open
 * @param appName - Optional name of the app for the window title
 * @param onError - Optional error callback
 * @returns Promise that resolves with the window label when the window is created (for focusing)
 */
export interface OpenAppFrontendContext {
  applicationId?: string;
  contextId?: string;
  executorPublicKey?: string;
}

// Guards against two concurrent openAppFrontend calls racing to create the same window.
const pendingWindowCreations = new Set<string>();

export async function openAppFrontend(
  frontendUrl: string,
  appName?: string,
  onError?: (error: Error) => void,
  context?: OpenAppFrontendContext,
): Promise<string | void> {
  try {
    const settings = getSettings();
    const nodeUrl = (settings.nodeUrl ?? '').replace(/\/$/, '');

    // Build URL hash with node_url and tokens so the app can skip the auth flow
    const hashParams = new URLSearchParams();
    hashParams.set('node_url', nodeUrl);
    const accessToken = getAccessToken();
    const refreshToken = getRefreshToken();
    if (accessToken && refreshToken) {
      hashParams.set('access_token', accessToken);
      hashParams.set('refresh_token', refreshToken);
      hashParams.set('expires_at', String(getTokenExpiresAt() ?? Date.now() + 3600_000));
    }
    if (context?.applicationId) hashParams.set('app-id', context.applicationId);
    if (context?.contextId) hashParams.set('context_id', context.contextId);
    if (context?.executorPublicKey) hashParams.set('executor_public_key', context.executorPublicKey);
    // Propagate the desktop's developer-mode setting so apps can surface
    // advanced diagnostics (e.g. Mero Meet's WebRTC panel). App windows are a
    // separate origin and can't read the desktop's settings localStorage.
    hashParams.set('dev_mode', settings.developerMode ? '1' : '0');

    const urlToOpen = `${frontendUrl}#${hashParams.toString()}`;

    // Stable window label keyed by applicationId so every call site
    // (Home, Applications, Namespaces, shortcut) produces the same label
    // for the same app and Tauri can focus the existing window.
    const urlObj = new URL(frontendUrl);
    const domain = `${urlObj.hostname}${urlObj.port ? `-${urlObj.port}` : ''}`.replace(/[^a-zA-Z0-9-]/g, '-');
    // Restrict to [a-zA-Z0-9-] to prevent label crafting via slash/colon/underscore.
    // Calimero applicationIds are base58-encoded 32-byte keys (~43 chars), so the
    // slice(0, 60) limit is never hit in practice and no truncation collisions occur.
    const appKey = context?.applicationId
      ? context.applicationId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 60)
      : domain;
    const windowLabel = `app-${appKey}`.slice(0, 64);

    // If the window is already open, focus it and signal a token refresh.
    // setFocus first: if it throws (window closed), we skip the emit entirely
    // so no credentials reach a window that may have navigated to a different origin.
    const existing = WebviewWindow.getByLabel(windowLabel);
    if (existing) {
      try {
        await existing.setFocus();
        // Signal apps to re-read their auth state. No token payload here to avoid
        // sending credentials to a window whose current origin we cannot verify.
        // dev_mode is not a credential, so we forward the current value: an
        // already-open app would otherwise keep the stale dev_mode from when its
        // window was first created until it is recreated.
        await existing
          .emit('calimero:auth-refresh', { dev_mode: settings.developerMode ? '1' : '0' })
          .catch(() => {});
        return windowLabel;
      } catch (e) {
        // window was closed between getByLabel and setFocus; fall through to create a new one
        console.warn('setFocus failed, opening new window:', e);
      }
    }

    // Guard concurrent calls: if another in-flight invocation is already creating
    // this window, return early — Tauri rejects duplicate labels.
    if (pendingWindowCreations.has(windowLabel)) {
      return windowLabel;
    }
    pendingWindowCreations.add(windowLabel);
    try {
      await invoke('create_app_window', {
        windowLabel,
        url: urlToOpen,
        title: appName || 'Application',
        openDevtools: false,
        nodeUrl: settings.nodeUrl,
      });
    } finally {
      pendingWindowCreations.delete(windowLabel);
    }

    return windowLabel;
  } catch (error) {
    const err = new Error(parseTauriError(error));
    console.error("Failed to open frontend:", err);

    if (onError) {
      onError(err);
    } else {
      throw err;
    }
  }
}
