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

    const urlToOpen = `${frontendUrl}#${hashParams.toString()}`;

    // Stable window label keyed by applicationId so every call site
    // (Home, Applications, Namespaces, shortcut) produces the same label
    // for the same app and Tauri can focus the existing window.
    const urlObj = new URL(frontendUrl);
    const domain = `${urlObj.hostname}${urlObj.port ? `-${urlObj.port}` : ''}`.replace(/[^a-zA-Z0-9]/g, '-');
    // Sanitize to Tauri's allowed label chars [a-zA-Z0-9-/_:] on both paths.
    const appKey = context?.applicationId
      ? context.applicationId.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60)
      : domain;
    const windowLabel = `app-${appKey}`.slice(0, 64);

    // If the window is already open, focus it and push fresh tokens via event.
    // Tauri v1 has no navigate() API; we emit 'calimero:auth-refresh' so apps
    // can update their auth state without a full reload.
    const existing = WebviewWindow.getByLabel(windowLabel);
    if (existing) {
      try {
        if (accessToken && refreshToken) {
          await existing.emit('calimero:auth-refresh', {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: getTokenExpiresAt() ?? Date.now() + 3600_000,
            node_url: nodeUrl,
          });
        }
        await existing.setFocus();
        return windowLabel;
      } catch (e) {
        // window was closed between getByLabel and setFocus; fall through to create a new one
        console.warn('setFocus failed, opening new window:', e);
      }
    }

    await invoke('create_app_window', {
      windowLabel,
      url: urlToOpen,
      title: appName || 'Application',
      openDevtools: false,
      nodeUrl: settings.nodeUrl,
    });

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
