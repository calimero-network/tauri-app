import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * The credential the cloud hands back over the `calimero://cloud-callback`
 * deep link is not always a Google ID token.
 *
 * When the browser already has a signed-in cloud session, the cloud sends THAT
 * — an MDMA session JWT — because re-running Google sign-in for someone who is
 * already signed in is a round trip for nothing. Before this was recognised
 * here, the cloud suppressed the hand-off rather than send one, and the desktop
 * sat on "Waiting for sign-in..." forever while the browser showed the
 * dashboard.
 *
 * Two facts drive the sign-in path and are pinned here: a session token must be
 * distinguishable from a Google one (or it gets posted to `/api/auth/google`,
 * which is not a valid exchange), and it carries `email` but NOT `name` or
 * `picture` — which is why the settings write keeps an existing profile instead
 * of overwriting it with the empty strings this yields.
 */

// settings.ts touches localStorage on import; keep it inert.
import { vi } from 'vitest';
vi.mock('./settings', () => ({ getSettings: () => ({}), saveSettings: () => {} }));
// The Tauri bridge (invoke/listen) and the cloud API are the IO seams the
// deep-link login flow drives; stub them so the flow can be exercised in node.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('./cloudApi', () => ({
  CLOUD_BASE_URL: 'https://cloud.calimero.network',
  getCloudNode: vi.fn().mockResolvedValue(null),
}));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { decodeIdToken, isMdmaSessionToken, startCloudLogin } from './cloudAuth';

function makeJwt(payload: object): string {
  const b64 = (s: string) => btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64(JSON.stringify({ alg: 'none' }))}.${b64(JSON.stringify(payload))}.sig`;
}

const exp = Math.floor(Date.now() / 1000) + 3600;
const SESSION = makeJwt({ iss: 'mdma', sub: 'user-1', email: 'sandi@calimero.network', exp });
const GOOGLE = makeJwt({
  iss: 'https://accounts.google.com',
  email: 'sandi@calimero.network',
  name: 'Sandi Fatic',
  picture: 'https://example.test/a.png',
  exp,
});

describe('the credential the cloud sends back', () => {
  it('distinguishes an MDMA session token from a Google one', () => {
    expect(isMdmaSessionToken(SESSION)).toBe(true);
    expect(isMdmaSessionToken(GOOGLE)).toBe(false);
  });

  it('reads the email from a session token, which is the claim it does carry', () => {
    expect(decodeIdToken(SESSION)?.email).toBe('sandi@calimero.network');
  });

  it('yields empty name and picture for a session token, the claims it does not carry', () => {
    const info = decodeIdToken(SESSION);
    expect(info?.name).toBe('');
    expect(info?.picture).toBe('');
  });

  it('still reads a full profile from a Google token', () => {
    const info = decodeIdToken(GOOGLE);
    expect(info?.name).toBe('Sandi Fatic');
    expect(info?.picture).toBe('https://example.test/a.png');
  });
});

/**
 * The `cloud-auth-callback` deep-link is a payload-less wake-up ping: the
 * callback URL (which carries the token) lives only in the main-window-only
 * PendingCloudAuth store, reachable via `get_pending_cloud_auth`. The frontend
 * must therefore pull the URL from that store on the ping rather than read a
 * URL off the event payload.
 *
 * The OAuth nonce (`consumePendingState`, a read-and-delete of the localStorage
 * key below) must only ever be touched for a URL the backend actually returned.
 * A bare/forged event with nothing pending must not burn it — otherwise a
 * single forged event is a login DoS (F6).
 */
const OAUTH_STATE_KEY = 'calimero_oauth_pending_state';

// Minimal in-memory localStorage — the test runs under the `node` environment,
// which has none, and cloudAuth persists the OAuth nonce there.
class MemStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, String(v));
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
}

function currentNonce(): string | null {
  const raw = (globalThis.localStorage as unknown as MemStorage).getItem(OAUTH_STATE_KEY);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { state?: string }).state ?? null;
  } catch {
    return null;
  }
}

describe('cloud-auth-callback: the wake-up ping carries no token (F3/F6)', () => {
  const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
  const listenMock = listen as unknown as ReturnType<typeof vi.fn>;
  let eventHandler: ((event: { payload?: unknown }) => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
    eventHandler = null;
    listenMock.mockReset();
    listenMock.mockImplementation(async (_name: string, cb: (e: { payload?: unknown }) => void) => {
      eventHandler = cb;
      return () => {};
    });
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a bare event with nothing pending does not consume the nonce (closes the DoS)', async () => {
    // Backend has no pending URL: get_pending_cloud_auth always returns null.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_cloud_auth') return null;
      return undefined;
    });

    const login = startCloudLogin();
    // Let startCloudLogin reach pollForCloudAuth and register the listener.
    await vi.advanceTimersByTimeAsync(1);
    expect(eventHandler).toBeTruthy();
    const nonceBefore = currentNonce();
    expect(nonceBefore).toBeTruthy();

    // Fire a forged bare ping (no payload). Old code read event.payload and
    // burned the nonce; new code drains PendingCloudAuth, finds nothing, and
    // leaves the nonce untouched.
    eventHandler!({});
    await vi.advanceTimersByTimeAsync(1);
    expect(currentNonce()).toBe(nonceBefore);

    // Drive the flow to its 2-minute timeout so the promise settles.
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(login).resolves.toBeNull();
    // The nonce was never consumed by the forged event.
    expect(currentNonce()).toBe(nonceBefore);
  });

  it('a real pending URL returned by the backend still completes login', async () => {
    // The backend hands back the genuine callback URL, echoing the nonce it was
    // started with. The ping triggers the pull; extract validates state and
    // returns the token.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_cloud_auth') {
        const state = currentNonce();
        if (!state) return null;
        return `calimero://cloud-callback?state=${state}#id_token=${SESSION}`;
      }
      return undefined;
    });

    const login = startCloudLogin();
    await vi.advanceTimersByTimeAsync(1);
    expect(eventHandler).toBeTruthy();
    expect(currentNonce()).toBeTruthy();

    // The wake-up ping funnels through the same drain the poll uses.
    eventHandler!({});
    await vi.advanceTimersByTimeAsync(1);

    const info = await login;
    expect(info?.email).toBe('sandi@calimero.network');
    // A genuine URL DID consume the nonce (single-use).
    expect(currentNonce()).toBeNull();
  });

  it('a forged bare event does not block a subsequent genuine login', async () => {
    let pendingUrl: string | null = null;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_pending_cloud_auth') return pendingUrl;
      return undefined;
    });

    const login = startCloudLogin();
    await vi.advanceTimersByTimeAsync(1);
    expect(eventHandler).toBeTruthy();
    const nonce = currentNonce();
    expect(nonce).toBeTruthy();

    // Forged ping first — must be a no-op for the nonce.
    eventHandler!({});
    await vi.advanceTimersByTimeAsync(1);
    expect(currentNonce()).toBe(nonce);

    // Now the genuine callback arrives with the SAME (still-valid) nonce.
    pendingUrl = `calimero://cloud-callback?state=${nonce}#id_token=${SESSION}`;
    eventHandler!({});
    await vi.advanceTimersByTimeAsync(1);

    const info = await login;
    expect(info?.email).toBe('sandi@calimero.network');
  });
});
