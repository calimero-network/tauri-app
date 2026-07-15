import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The broker only runs inside the desktop window, where the Tauri API and a real
// token store exist. Mock both so the module is testable under the `node` vitest
// environment (no localStorage, no IPC).
const listen = vi.fn();
const invoke = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));
vi.mock('@tauri-apps/api/tauri', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock('../utils/settings', () => ({
  getSettings: () => ({ nodeUrl: 'http://localhost:2528' }),
}));

let accessToken: string | null;
let storedRefreshToken: string | null;
let expiresAt: number | null;
vi.mock('./token-storage', () => ({
  getAccessToken: () => accessToken,
  getRefreshToken: () => storedRefreshToken,
  getTokenExpiresAt: () => expiresAt,
  setAccessToken: (t: string) => { accessToken = t; },
  setRefreshToken: (t: string) => { storedRefreshToken = t; },
  setTokenExpiresAt: (e: number) => { expiresAt = e; },
}));

// Imported fresh for every test: the module keeps the in-flight rotation and the
// captured original `fetch` in module scope, and a test must never inherit either.
type Broker = typeof import('./token-broker');
let broker: Broker;

/** A promise plus its resolver, so a test can hold a rotation open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function refreshResponse(pair: { access_token: string; refresh_token: string }) {
  return new Response(JSON.stringify({ data: pair }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const FRESH = () => Date.now() + 3600_000;
const EXPIRED = () => Date.now() - 1_000;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  accessToken = 'access-1';
  storedRefreshToken = 'refresh-1';
  expiresAt = FRESH();
  listen.mockResolvedValue(() => {});
  invoke.mockResolvedValue(undefined); // real invoke() always returns a promise

  // A fresh Response per call: a body can only be read once, and some tests
  // rotate twice.
  fetchMock = vi.fn().mockImplementation(async () =>
    refreshResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }),
  );
  vi.stubGlobal('window', { fetch: fetchMock, location: { href: 'http://localhost:1420/' } });
  vi.stubGlobal('fetch', fetchMock);

  vi.resetModules();
  broker = await import('./token-broker');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The JSON body of the Nth POST /auth/refresh. */
function refreshBody(n = 0) {
  const [, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe('rotateTokens', () => {
  it('POSTs the stored token pair to the node and persists what comes back', async () => {
    await expect(broker.rotateTokens()).resolves.toEqual({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:2528/auth/refresh');
    expect(refreshBody()).toEqual({ access_token: 'access-1', refresh_token: 'refresh-1' });

    // The consumed token must be gone from storage — keeping it is exactly what
    // trips token_reuse on the next rotation.
    expect(storedRefreshToken).toBe('refresh-2');
    expect(accessToken).toBe('access-2');
  });

  // The core#3083 guard. A second concurrent POST would present the token the
  // first one just consumed; the node calls that theft and revokes the family.
  it('collapses concurrent rotations into exactly one /auth/refresh', async () => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValue(gate.promise);

    const all = Promise.all([broker.rotateTokens(), broker.rotateTokens(), broker.rotateTokens()]);
    gate.resolve(refreshResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }));

    const results = await all;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Every caller gets the same rotated pair.
    expect(results).toEqual([
      { access_token: 'access-2', refresh_token: 'refresh-2' },
      { access_token: 'access-2', refresh_token: 'refresh-2' },
      { access_token: 'access-2', refresh_token: 'refresh-2' },
    ]);
  });

  it('re-reads the store, so a stale caller cannot replay a consumed token', async () => {
    await broker.rotateTokens(); // consumes refresh-1, stores refresh-2
    await broker.rotateTokens();

    // The second rotation must present refresh-2 (from the store), never refresh-1.
    expect(refreshBody(1).refresh_token).toBe('refresh-2');
  });

  it('rejects when the desktop is not authenticated', async () => {
    accessToken = null;
    storedRefreshToken = null;

    await expect(broker.rotateTokens()).rejects.toThrow('Desktop is not authenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the node`s auth error reason', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_reuse' } }),
    );

    await expect(broker.rotateTokens()).rejects.toThrow('token_reuse');
  });
});

describe('installRefreshSingleFlight', () => {
  it('serves every MeroJs refresh from one rotation, in the node`s wire format', async () => {
    broker.installRefreshSingleFlight();

    // Three MeroJs instances each hitting a 401 at once — as the desktop really
    // does (lazy apiClient + createClientAsync + StrictMode double-mount).
    const responses = await Promise.all([
      window.fetch('http://localhost:2528/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1' }),
      }),
      window.fetch('http://localhost:2528/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1' }),
      }),
      window.fetch('http://localhost:2528/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1' }),
      }),
    ]);

    // One real POST for three callers — the whole point.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    for (const response of responses) {
      expect(response.status).toBe(200);
      // Shaped exactly like the node's reply, so each MeroJs updates its own
      // cache and token store as it normally would.
      expect(await response.json()).toEqual({
        data: { access_token: 'access-2', refresh_token: 'refresh-2' },
      });
    }
  });

  it('leaves every other request alone', async () => {
    broker.installRefreshSingleFlight();

    await window.fetch('http://localhost:2528/admin-api/health');
    await window.fetch('http://localhost:2528/auth/refresh', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:2528/admin-api/health');
  });

  it('answers a failed rotation with a 401 rather than hanging the caller', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_reuse' } }),
    );
    broker.installRefreshSingleFlight();

    const response = await window.fetch('http://localhost:2528/auth/refresh', {
      method: 'POST',
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('token_reuse');
  });
});

describe('brokerAccessToken', () => {
  it('hands back the stored access token without rotating when it is still fresh', async () => {
    await expect(broker.brokerAccessToken()).resolves.toBe('access-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a token expiring inside the skew window as expired', async () => {
    expiresAt = Date.now() + 5_000; // < 30s skew
    await expect(broker.brokerAccessToken()).resolves.toBe('access-2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rotates when the stored access token has expired', async () => {
    expiresAt = EXPIRED();
    await expect(broker.brokerAccessToken()).resolves.toBe('access-2');
  });
});

describe('startTokenBroker', () => {
  /** Run the handler registered for `calimero:token-request`. */
  async function fireRequest(requestId: string | undefined) {
    await broker.startTokenBroker();
    const [eventName, handler] = listen.mock.calls[0] as [string, (e: unknown) => Promise<void>];
    expect(eventName).toBe('calimero:token-request');
    await handler({ payload: requestId === undefined ? {} : { requestId } });
  }

  it('answers an app window with an access token — and never a refresh token', async () => {
    await fireRequest('tok-1');

    expect(invoke).toHaveBeenCalledWith('resolve_token_request', {
      requestId: 'tok-1',
      accessToken: 'access-1',
    });

    // The refresh token must never leave the desktop.
    const [, payload] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(payload)).not.toContain('refreshToken');
    expect(JSON.stringify(payload)).not.toContain('refresh-1');
  });

  it('answers with an error instead of leaving the app window hanging', async () => {
    accessToken = null;
    storedRefreshToken = null;
    expiresAt = null;

    await fireRequest('tok-2');

    expect(invoke).toHaveBeenCalledWith('resolve_token_request', {
      requestId: 'tok-2',
      error: 'Desktop is not authenticated',
    });
  });

  it('ignores a malformed request with no id', async () => {
    await fireRequest(undefined);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('BROKERED_REFRESH_TOKEN', () => {
  it('is non-empty — an empty slot would stop mero-js from ever calling /auth/refresh', () => {
    // mero-js's performTokenRefresh() throws "No refresh token available" and
    // never hits the network when the refresh-token slot is empty, so the app
    // could not refresh at all rather than being brokered.
    expect(broker.BROKERED_REFRESH_TOKEN).toBeTruthy();
  });

  it('matches the sentinel hard-coded in proxy_script.js', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const path = await import('path');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const script = readFileSync(path.resolve(dir, '../../src-tauri/src/proxy_script.js'), 'utf-8');
    expect(script).toContain(
      `const BROKERED_REFRESH_TOKEN = '${broker.BROKERED_REFRESH_TOKEN}'`,
    );
  });
});
