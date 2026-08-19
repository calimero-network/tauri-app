/**
 * Desktop token broker — the desktop is the SINGLE holder and SINGLE rotator
 * of the refresh token.
 *
 * Why this exists (calimero-network/core#3083):
 * refresh tokens are single-use. Every `POST /auth/refresh` consumes the
 * presented refresh token and mints a new one; re-presenting a consumed token
 * is treated as theft — the server revokes the whole token family and replies
 * 401 `x-auth-error: token_reuse`, logging out every holder.
 *
 * Two independent things used to break that rule, and this module fixes both by
 * funnelling every rotation — the desktop's own and every app window's —
 * through one single-flight `rotateTokens()`:
 *
 * 1. **Across webviews.** Each app webview is a separate origin with its own
 *    localStorage and its own MeroJs. The desktop used to hand its real refresh
 *    token to every app window in the SSO URL hash, so each one would rotate it
 *    independently: the first consumes it, the next presents a consumed token,
 *    family revoked, everything logged out. Now app windows never receive the
 *    real refresh token — they get `BROKERED_REFRESH_TOKEN`, and the proxy
 *    script (src-tauri/src/proxy_script.js) routes their `/auth/refresh` calls
 *    to the `broker_token_refresh` Tauri command, which lands in
 *    `startTokenBroker()` below.
 *
 * 2. **Within the desktop itself.** The desktop holds more than one MeroJs
 *    instance (the lazily-created `apiClient` default, the one built by
 *    `createClientAsync`, plus React StrictMode double-mounting in dev). Each
 *    has its own token cache and its own refresh dedupe, so a burst of 401s
 *    produced several concurrent `POST /auth/refresh` calls all presenting the
 *    same token — one succeeded and the rest tripped `token_reuse`.
 *    `installRefreshSingleFlight()` patches `fetch` so every one of those calls
 *    collapses into a single rotation whose result they all share.
 *
 * mero-js's own single-flight and `navigator.locks` serialization (mero-js#67)
 * only coordinate holders *within one origin* and *one instance tree*, so they
 * cannot solve either case for us regardless of the mero-js version pinned here.
 *
 * Apps need no changes: an unmodified mero-js/mero-react app still just calls
 * `/auth/refresh` and gets a well-formed reply.
 */
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getSettings } from '../utils/settings';
import {
  getAccessToken,
  getRefreshToken,
  getTokenExpiresAt,
  setAccessToken,
  setRefreshToken,
  setTokenExpiresAt,
} from './token-storage';

/**
 * Sentinel handed to app windows in place of the real refresh token.
 *
 * It only has to be non-empty: mero-js's `performTokenRefresh()` throws
 * "No refresh token available" and never calls `/auth/refresh` when the slot is
 * empty, so an app given no refresh token at all could not refresh — it would
 * simply hard-fail on the first 401. The sentinel keeps the app on its normal
 * refresh code path, which the proxy script then brokers.
 *
 * It is not a credential: the proxy script recognizes this exact value in a
 * `/auth/refresh` body and brokers that call instead of forwarding it, so it is
 * never sent to the node. Even if it leaked it is not a valid token - and, not
 * being a real `jti`, it cannot trip reuse detection or revoke anyone's token
 * family.
 *
 * MUST be kept in sync with BROKERED_REFRESH_TOKEN in proxy_script.js.
 */
export const BROKERED_REFRESH_TOKEN = 'calimero-desktop-brokered-refresh-token';

/** Treat an access token expiring within this window as already expired. */
const EXPIRY_SKEW_MS = 30_000;

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

/** The one in-flight rotation. Every caller — desktop or app — shares it. */
let inflight: Promise<TokenPair> | null = null;

/** `fetch` as it was before we patched it; the rotation must not re-enter us. */
let originalFetch: typeof fetch | null = null;

/** `true` when the stored access token is still usable as-is. */
function accessTokenIsFresh(): boolean {
  const expiresAt = getTokenExpiresAt();
  if (expiresAt === null) return false;
  return expiresAt - Date.now() > EXPIRY_SKEW_MS;
}

function expiresAtFromJwt(accessToken: string): number {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1]));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // not a JWT / unparseable — fall through
  }
  return Date.now() + 3600_000;
}

/** True for a `POST` to the node's `/auth/refresh`. */
function isRefreshRequest(url: string, method: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  try {
    return new URL(url, window.location.href).pathname.replace(/\/+$/, '').endsWith('/auth/refresh');
  } catch {
    return false;
  }
}

/**
 * Rotate the refresh token exactly once, however many callers are asking.
 *
 * The refresh token is re-read from storage inside the single-flight rather than
 * taken from the caller: a MeroJs instance that cached its tokens before an
 * earlier rotation would otherwise present an already-consumed token and revoke
 * the family. Storage is the source of truth after the first rotation.
 */
export function rotateTokens(): Promise<TokenPair> {
  if (inflight) return inflight;

  const run = async (): Promise<TokenPair> => {
    const accessToken = getAccessToken();
    const refreshToken = getRefreshToken();
    if (!accessToken || !refreshToken) {
      throw new Error('Desktop is not authenticated');
    }

    const doFetch = originalFetch ?? fetch;
    const baseUrl = (getSettings().nodeUrl ?? '').replace(/\/$/, '');
    const response = await doFetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
    });

    if (!response.ok) {
      const reason = response.headers.get('x-auth-error') ?? String(response.status);
      throw new Error(`Token refresh failed: ${reason}`);
    }

    const body = await response.json();
    const rotated: TokenPair | undefined = body?.data;
    if (!rotated?.access_token || !rotated?.refresh_token) {
      throw new Error('Token refresh returned no tokens');
    }

    // Persist before any caller can read the store again, so the consumed token
    // is never handed back out.
    setAccessToken(rotated.access_token);
    setRefreshToken(rotated.refresh_token);
    setTokenExpiresAt(expiresAtFromJwt(rotated.access_token));

    return rotated;
  };

  inflight = run().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Collapse every `POST /auth/refresh` made from this window into one rotation.
 *
 * The desktop runs several MeroJs instances that each cache their own tokens and
 * dedupe refreshes only among their own requests, so a burst of 401s used to
 * produce several concurrent refresh POSTs carrying the same single-use token.
 * Patching `fetch` is the only join point we have over instances we do not own —
 * and it is what the app windows already do, via the injected proxy script.
 *
 * Every caller gets the same rotated pair back in the node's own wire format, so
 * each MeroJs updates its cache and its token store exactly as it would have.
 */
export function installRefreshSingleFlight(): void {
  if (originalFetch) return; // already installed
  originalFetch = window.fetch.bind(window);
  const passthrough = originalFetch;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method =
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');

    if (!isRefreshRequest(url, method) || !getRefreshToken()) {
      return passthrough(input as RequestInfo, init);
    }

    try {
      const rotated = await rotateTokens();
      return new Response(JSON.stringify({ data: rotated }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : 'refresh failed' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }
  };
}

/**
 * Return an access token an app window can use, rotating only when needed.
 *
 * The common case is cheap: an app's access token expired but the desktop (or
 * another app window, brokered through here) already rotated, so the stored one
 * is fresh and we just hand it over — no `/auth/refresh` at all.
 */
export async function brokerAccessToken(): Promise<string> {
  const accessToken = getAccessToken();
  if (accessToken && accessTokenIsFresh()) return accessToken;
  const rotated = await rotateTokens();
  return rotated.access_token;
}

/**
 * Serve `broker_token_refresh` requests relayed from app windows by Rust.
 * Returns an unlisten function.
 */
export async function startTokenBroker(): Promise<() => void> {
  return listen<{ requestId: string }>('calimero:token-request', async (event) => {
    const requestId = event.payload?.requestId;
    if (!requestId) return;

    try {
      const accessToken = await brokerAccessToken();
      await invoke('resolve_token_request', { requestId, accessToken });
    } catch (error) {
      // Always answer: a dropped reply would leave the app window's fetch
      // hanging until the Rust-side timeout.
      await invoke('resolve_token_request', {
        requestId,
        error: error instanceof Error ? error.message : 'Token refresh failed',
      }).catch(() => {});
    }
  });
}
