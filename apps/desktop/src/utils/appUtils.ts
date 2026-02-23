import { invoke } from "@tauri-apps/api/tauri";
import { getSettings } from "./settings";

/**
 * Appends the current node_url as a query parameter to a frontend URL.
 * Encodes the node URL so the full string is valid (?, #, &, =, %, :, / etc. don't break the query).
 * The opened app can read it via URLSearchParams.get('node_url') (decoded automatically).
 */
function appendNodeUrlParam(frontendUrl: string, nodeUrl: string): string {
  if (!nodeUrl) return frontendUrl;
  const encoded = encodeURIComponent(nodeUrl);
  try {
    const url = new URL(frontendUrl);
    url.searchParams.set("node_url", nodeUrl); // URLSearchParams encodes when setting
    return url.toString();
  } catch {
    // If URL parsing fails, append with ? or &
    const separator = frontendUrl.includes("?") ? "&" : "?";
    return `${frontendUrl}${separator}node_url=${encoded}`;
  }
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
    const urlToOpen = appendNodeUrlParam(frontendUrl, settings.nodeUrl ?? '');
    
    // Generate unique window label based on domain + timestamp to avoid conflicts
    const urlObj = new URL(frontendUrl);
    const domain = urlObj.hostname.replace(/\./g, '-'); // Replace dots with dashes for label
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
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Failed to open frontend:", err);
    
    if (onError) {
      onError(err);
    } else {
      throw err;
    }
  }
}
