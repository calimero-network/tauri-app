import { invoke } from "@tauri-apps/api/tauri";
import { getSettings } from "./settings";
import { getAccessToken, getRefreshToken } from "@calimero-network/mero-react";

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
      // Assume it's base64 encoded string
      jsonString = atob(metadata);
    } else if (Array.isArray(metadata)) {
      // Convert array of bytes to string
      jsonString = String.fromCharCode(...metadata);
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
export async function openAppFrontend(
  frontendUrl: string,
  appName?: string,
  onError?: (error: Error) => void
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
      hashParams.set('expires_in', '3600');
    }

    const urlToOpen = `${frontendUrl}#${hashParams.toString()}`;

    // Generate unique window label based on domain + timestamp to avoid conflicts
    const urlObj = new URL(frontendUrl);
    const domain = urlObj.hostname.replace(/\./g, '-');
    const windowLabel = `app-${domain}-${Date.now()}`;

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
