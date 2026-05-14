import { invoke } from '@tauri-apps/api';
import { listen } from '@tauri-apps/api/event';
import { getSettings, saveSettings } from './settings';
import { CLOUD_BASE_URL, getCloudNode } from './cloudApi';
import { parseJwtPayload, isMdmaSessionToken, isTokenExpired } from './jwt';

export { isMdmaSessionToken, isTokenExpired };

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
  const payload = parseJwtPayload(token);
  if (!payload) return null;
  return {
    email: typeof payload.email === 'string' ? payload.email : '',
    name: typeof payload.name === 'string' ? payload.name : '',
    picture: typeof payload.picture === 'string' ? payload.picture : '',
  };
}

interface MdmaSessionResponse {
  session_token: string;
  expires_at: number;
  // Nullable: if the server's `user` field is missing/malformed but the
  // session_token is otherwise valid (MDMA-issued JWT), we keep the
  // 7-day session and let the call site fall back to decodeIdToken(googleToken)
  // for the profile chip — see the shape-validation branch in
  // exchangeGoogleForMdmaSession.
  user: CloudUserInfo | null;
}

/**
 * Exchange a Google OAuth ID token for an MDMA session token.
 * Called once after the OAuth deep-link callback returns a Google
 * credential. The resulting session token is what gets persisted in
 * `settings.cloudIdToken` and used for every subsequent cloud API
 * call — MDMA session tokens live for 7 days and are silently rolled
 * forward by the server (see `cloudFetch`), so the user no longer
 * has to re-authenticate every hour.
 *
 * Returns `null` if the exchange fails for any reason; callers should
 * fall back to using the raw Google token during the backend's
 * migration window (`_verify_session_or_google` still accepts Google
 * tokens). Once the fallback is removed, the exchange becoming
 * mandatory will surface as a login failure at the call site.
 */
async function exchangeGoogleForMdmaSession(
  googleIdToken: string,
): Promise<MdmaSessionResponse | null> {
  try {
    const res = await fetch(`${CLOUD_BASE_URL}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: googleIdToken }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    // Validate the shape before trusting the cast. A 200 with an
    // unexpected body (deployment mid-rollout, bad proxy) would
    // otherwise fall through as `{ session_token: undefined }` and
    // the nullish-coalesce in startCloudLogin would silently re-use
    // the raw Google token — masking a server regression.
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { session_token?: unknown }).session_token !== 'string' ||
      !(body as { session_token: string }).session_token
    ) {
      return null;
    }
    // Belt-and-suspenders: confirm what we got back is actually an
    // MDMA-issued JWT. A misconfigured backend (or a bug in the
    // exchange handler) could return a 200 with a session_token that
    // is a non-JWT string, a JWT with the wrong issuer, or even our
    // own Google token echoed back — none of which should be allowed
    // to land in settings.cloudIdToken. isMdmaSessionToken returns
    // false on all of those so we reject and surface as a login
    // failure at the call site.
    if (!isMdmaSessionToken((body as { session_token: string }).session_token)) {
      return null;
    }
    // Validate the user claim shape independently from the session_token.
    // startCloudLogin reads exchange.user.{email,name,picture} directly
    // into settings, so a 200 body with a missing/malformed `user` field
    // would persist `undefined` strings and surface as a blank profile
    // chip. Crucially we *don't* discard the whole response on a bad
    // `user` — the session_token has already been validated as an
    // MDMA-issued JWT above, and dropping the 7-day session because of
    // a cosmetic profile field would silently degrade the user to the
    // 1-hour Google fallback. Returning `user: null` lets the call site's
    // `exchange?.user ?? decodeIdToken(googleToken)` fallback populate
    // the profile from the ID-token claims while keeping the long session.
    const userField = (body as { user?: unknown }).user;
    const userValid =
      !!userField &&
      typeof userField === 'object' &&
      typeof (userField as { email?: unknown }).email === 'string' &&
      typeof (userField as { name?: unknown }).name === 'string' &&
      typeof (userField as { picture?: unknown }).picture === 'string';
    return {
      session_token: (body as { session_token: string }).session_token,
      expires_at:
        typeof (body as { expires_at?: unknown }).expires_at === 'number'
          ? (body as { expires_at: number }).expires_at
          : 0,
      user: userValid ? (userField as CloudUserInfo) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget server-side session revocation. Adds the session's
 * sid to the RevokedSession table so the same token can't be
 * refreshed or re-used. No await / no error surfacing — the caller
 * has already cleared local state and the worst case is a
 * short-lived token staying usable until its exp.
 *
 * Safe to call with a Google token or undefined; non-MDMA tokens
 * short-circuit without hitting the network.
 */
export function revokeMdmaSession(sessionToken: string | undefined | null): void {
  if (!sessionToken || !isMdmaSessionToken(sessionToken)) return;
  fetch(`${CLOUD_BASE_URL}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
  })
    .then((res) => {
      // fetch only rejects on network-level failure; a 4xx/5xx response
      // resolves successfully and would otherwise be silently ignored.
      // Surface non-OK statuses too so the dev console reflects the
      // session_t actually staying alive server-side.
      if (!res.ok) {
        console.warn(
          'MDMA session revocation returned non-OK status:',
          res.status,
          res.statusText,
        );
      }
    })
    .catch((err) => {
      // Best-effort: we don't block logout on this. But a persistent
      // failure (wrong URL, TLS issue, DNS) leaves sessions unrevoked
      // server-side — log so the dev console surfaces it rather than
      // the failure being completely invisible.
      console.warn('MDMA session revocation failed (best-effort):', err);
    });
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
  const googleToken = await pollForCloudAuth();
  if (!googleToken) return null;

  // Exchange the Google credential for a 7-day MDMA session. The
  // session token is what gets persisted and used for every cloud API
  // call — the Google token is one-shot. If the exchange fails
  // (server temporarily unavailable, network blip) we fall back to
  // the raw Google token; the backend's migration-window middleware
  // still accepts Google tokens, so the user is not blocked. The
  // fallback expires in ~1 hour and the user will re-auth at that
  // point.
  const exchange = await exchangeGoogleForMdmaSession(googleToken);
  const token = exchange?.session_token ?? googleToken;
  const userInfo = exchange?.user ?? decodeIdToken(googleToken);
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
 * Disconnect from Calimero Cloud. Clears all cloud state from settings
 * and fires a best-effort server-side session revocation so the same
 * sid can't be replayed.
 */
export function disconnectCloud(): void {
  clearPendingState();
  const settings = getSettings();
  // Revoke before clearing: once settings.cloudIdToken is undefined,
  // we can't address the session on the server any more.
  revokeMdmaSession(settings.cloudIdToken);
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
