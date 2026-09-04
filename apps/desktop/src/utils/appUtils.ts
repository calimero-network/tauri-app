import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getSettings } from "./settings";
import { getAccessToken, getRefreshToken, getTokenExpiresAt } from "../lib/token-storage";
import { BROKERED_REFRESH_TOKEN } from "../lib/token-broker";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Calls `check` every `intervalMs` until it resolves true or `deadlineMs` elapses. */
export async function pollUntil(
  check: () => Promise<boolean>,
  { deadlineMs, intervalMs }: { deadlineMs: number; intervalMs: number }
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

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
 * Appends a raw query string (without leading `?`) to a URL, preserving any
 * query already present on the base URL. Deep-link params take precedence on
 * key collisions. Returns the base URL unchanged when `params` is empty.
 */
export function appendParamsToUrl(baseUrl: string, params: string): string {
  if (!params) return baseUrl;
  try {
    const u = new URL(baseUrl);
    const incoming = new URLSearchParams(params);
    incoming.forEach((value, key) => u.searchParams.set(key, value));
    return u.toString();
  } catch {
    // Non-absolute or unparseable base — fall back to naive concatenation.
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${params}`;
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
  /** The app's bundled launcher icon (`metadata.icon`, a `data:image/png;base64,…`
   * URI). The backend prefers it over fetching the app's web favicon. */
  iconData?: string;
  /** Node this app should run against. Defaults to the one the desktop is on;
   * anything else opens an isolated window that logs in for itself. */
  targetNodeUrl?: string;
}

/** Canonical form for comparing two node URLs: scheme, host case, port and
 *  trailing slashes are cosmetic. Deliberately does NOT equate localhost with
 *  127.0.0.1 - they are separate web origins, so they hold separate sessions. */
export function normalizeNodeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

/** Label-safe fragment identifying a node target. Derived from the same
 *  canonical form as the isolation key, so two targets that get separate
 *  storage can never share a window label. */
function nodeKey(nodeUrl: string): string {
  const canonical = normalizeNodeUrl(nodeUrl).replace(/^https?:\/\//, (m) =>
    m.startsWith('https') ? 'https-' : 'http-',
  );
  // Always hash: sanitising maps '.' and ':' both to '-', so a.b and a-b would
  // otherwise share a label - and the label is what decides window reuse.
  let h = 0;
  for (let i = 0; i < canonical.length; i++) h = (Math.imul(31, h) + canonical.charCodeAt(i)) | 0;
  const safe = canonical.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 20);
  return `${safe}-${(h >>> 0).toString(36)}`;
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
    // Prefer opening the app as a first-class process via its per-app
    // shell/launcher (own dock icon + Cmd-Tab + native summon; the shell injects
    // SSO itself). `open_app_launcher` errors on non-macOS (or if the launcher
    // can't be built), and we fall back to the in-process window below.
    const settings = getSettings();
    const activeNodeUrl = (settings.nodeUrl ?? '').replace(/\/+$/, '');
    const nodeUrl = (context?.targetNodeUrl ?? settings.nodeUrl ?? '').replace(/\/+$/, '');
    // The launcher keeps one bundle per app with its node URL baked in, so it
    // cannot serve a second node; cross-node opens take the in-process path.
    const isCrossNode = normalizeNodeUrl(nodeUrl) !== normalizeNodeUrl(activeNodeUrl);

    if (context?.applicationId && !isCrossNode) {
      try {
        await invoke('open_app_launcher', {
          appName: appName ?? 'Application',
          frontendUrl,
          appId: context.applicationId,
          icon: context.iconData ?? null,
          nodeUrl: settings.nodeUrl,
        });
        return;
      } catch (e) {
        console.warn('[open] launcher path failed, falling back to in-process window:', e);
      }
    }

    // Build URL hash with node_url and the access token so the app can skip the
    // auth flow.
    //
    // The REAL refresh token is deliberately not shared. Refresh tokens are
    // single-use (calimero-network/core#3083): each POST /auth/refresh consumes
    // the presented token, and re-presenting a consumed one is treated as theft
    // — the node revokes the whole token family and every holder is logged out.
    // Each app webview is its own origin with its own localStorage and its own
    // MeroJs, so handing them all the same refresh token guarantees exactly that
    // collision. Instead the desktop keeps the refresh token and stays the sole
    // rotator: apps get BROKERED_REFRESH_TOKEN, and their /auth/refresh calls are
    // intercepted by the injected proxy script and served by the desktop.
    // See src/lib/token-broker.ts.
    const hashParams = new URLSearchParams();
    hashParams.set('node_url', nodeUrl);
    const accessToken = getAccessToken();
    const refreshToken = getRefreshToken();
    // Our session belongs to the active node, so a cross-node window gets no
    // credentials: it logs in for itself inside its own isolated store.
    if (!isCrossNode && accessToken && refreshToken) {
      hashParams.set('access_token', accessToken);
      hashParams.set('refresh_token', BROKERED_REFRESH_TOKEN);
      hashParams.set('expires_at', String(getTokenExpiresAt() ?? Date.now() + 3600_000));
    }
    if (context?.applicationId) hashParams.set('app-id', context.applicationId);
    if (context?.contextId) hashParams.set('context_id', context.contextId);
    if (context?.executorPublicKey) hashParams.set('executor_public_key', context.executorPublicKey);
    // Propagate the desktop's developer-mode setting so apps can surface
    // advanced diagnostics (e.g. Mero Meet's WebRTC panel). App windows are a
    // separate origin and can't read the desktop's settings localStorage.
    // Only set the flag when enabled: apps treat its absence as "off", so we
    // avoid leaking the user's dev-mode preference to every app frontend.
    if (settings.developerMode) hashParams.set('dev_mode', '1');

    // Cache-bust the document URL so the webview loads fresh HTML on open instead
    // of a stale cached index.html pointing at an old bundle. Query param, not the
    // SSO hash; auth is per-origin so SSO/localStorage are unaffected.
    let urlToOpen: string;
    try {
      const u = new URL(frontendUrl);
      u.searchParams.set('_cb', String(Date.now()));
      urlToOpen = `${u.toString()}#${hashParams.toString()}`;
    } catch {
      urlToOpen = `${frontendUrl}#${hashParams.toString()}`;
    }

    // Stable window label keyed by applicationId so every call site
    // (Home, Applications, Namespaces, shortcut) produces the same label
    // for the same app and Tauri can focus the existing window.
    const urlObj = new URL(frontendUrl);
    const domain = `${urlObj.hostname}${urlObj.port ? `-${urlObj.port}` : ''}`.replace(/[^a-zA-Z0-9-]/g, '-');
    // Restrict to [a-zA-Z0-9-] to prevent label crafting via slash/colon/underscore.
    // Calimero applicationIds are base58-encoded 32-byte keys (~43 chars), so the
    // slice(0, 60) limit is never hit in practice and no truncation collisions occur.
    // A cross-node window needs its own label or Tauri focuses the existing one
    // instead of opening a second. Same-node labels stay byte-identical.
    // Derive from host AND port: URL.port is empty on a scheme's default port,
    // so two different hosts would otherwise collapse to the same suffix.
    let nodeSuffix = '';
    if (isCrossNode) {
      nodeSuffix = `-n${nodeKey(nodeUrl)}`;
    }
    // Both branches must leave room for the suffix: truncating it away would let
    // two node targets share a label, and the label is what reuses a window.
    const budget = 60 - nodeSuffix.length;
    const appKey = (context?.applicationId ?? domain)
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .slice(0, budget);
    const windowLabel = `app-${appKey}${nodeSuffix}`.slice(0, 64);

    // If the window is already open, restore + focus it and signal a token refresh.
    // A window minimized to the macOS dock does NOT come back on setFocus alone —
    // it must be unminimized first (and shown, in case it was hidden), otherwise
    // clicking "Open" on an already-open-but-minimized app appears to do nothing.
    // These run before the emit: if any throw (window closed), we skip the emit
    // so no credentials reach a window that may have navigated to a different origin.
    // v2: WebviewWindow.getByLabel is async and resolves to null when absent.
    const existing = await WebviewWindow.getByLabel(windowLabel);
    if (existing) {
      try {
        if (await existing.isMinimized()) await existing.unminimize();
        await existing.show();
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
        // window was closed between getByLabel and restore/focus; fall through to create a new one
        console.warn('focus existing window failed, opening new one:', e);
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
        title: isCrossNode ? `${appName || 'Application'} - ${nodeUrl}` : appName || 'Application',
        openDevtools: false,
        nodeUrl,
        isolationKey: isCrossNode ? `${context?.applicationId ?? domain}@${nodeUrl}` : null,
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
