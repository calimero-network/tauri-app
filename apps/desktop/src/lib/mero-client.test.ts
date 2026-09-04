import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/** The three keys the desktop has always persisted. Renaming one, or changing
 *  what it holds, logs every existing user out on upgrade. */
const ACCESS_KEY = 'calimero_access_token';
const REFRESH_KEY = 'calimero_refresh_token';
const EXPIRES_KEY = 'calimero_token_expires_at';

/** `exp` 2_000_000_000 (2033-05-18), so the JWT branch is never the fallback. */
const EXP_SECONDS = 2_000_000_000;

function jwtWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const { createClientAsync } = await import('./mero-client');

const realFetch = globalThis.fetch;

function respondWith(response: () => Response): void {
  globalThis.fetch = async () => response();
}

beforeEach(() => store.clear());
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the persisted token format', () => {
  it('writes the three keys the app has always written', async () => {
    const client = await createClientAsync({ baseUrl: 'http://localhost:2528' });
    const access = jwtWithExp(EXP_SECONDS);

    // 0 is what the login paths pass: the SDK reads `exp` off the JWT itself.
    client.meroJs.setTokenData({
      access_token: access,
      refresh_token: 'refresh',
      expires_at: 0,
    });

    expect(store.get(ACCESS_KEY)).toBe(access);
    expect(store.get(REFRESH_KEY)).toBe('refresh');
    expect(store.get(EXPIRES_KEY)).toBe(String(EXP_SECONDS * 1000));
  });

  it('adopts a bundle an earlier version left behind', async () => {
    store.set(ACCESS_KEY, 'stored-access');
    store.set(REFRESH_KEY, 'stored-refresh');
    store.set(EXPIRES_KEY, '1700000000000');

    const client = await createClientAsync({ baseUrl: 'http://localhost:2528' });

    expect(client.meroJs.getTokenData()).toEqual({
      access_token: 'stored-access',
      refresh_token: 'stored-refresh',
      expires_at: 1700000000000,
    });
  });

  it('clears all three, so a sign-out leaves nothing to resume from', async () => {
    const client = await createClientAsync({ baseUrl: 'http://localhost:2528' });
    client.meroJs.setTokenData({
      access_token: jwtWithExp(EXP_SECONDS),
      refresh_token: 'refresh',
      expires_at: 0,
    });

    client.meroJs.clearToken();

    expect(store.has(ACCESS_KEY)).toBe(false);
    expect(store.has(REFRESH_KEY)).toBe(false);
    expect(store.has(EXPIRES_KEY)).toBe(false);
  });
});

describe('unauthorized detection', () => {
  it('names a 401 with the code the app routes back to login on', async () => {
    const client = await createClientAsync({ baseUrl: 'http://node' });
    respondWith(() => new Response('{}', { status: 401 }));

    expect(await client.node.healthCheck()).toEqual({
      error: { message: 'Unauthorized', code: '401' },
    });
  });

  it('reads the status, not the message: a 500 that mentions 401 is not a sign-out', async () => {
    const client = await createClientAsync({ baseUrl: 'http://node' });
    respondWith(
      () => new Response(JSON.stringify({ error: 'upstream answered 401' }), { status: 500 }),
    );

    const response = await client.node.healthCheck();

    expect(response.error?.code).toBeUndefined();
    expect(response.error?.message).toContain('upstream answered 401');
  });

  it('carries the same code for a revoked family, which no retry can recover', async () => {
    const client = await createClientAsync({ baseUrl: 'http://node' });
    respondWith(
      () => new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_reuse' } }),
    );

    expect(await client.node.healthCheck()).toEqual({
      error: { message: 'Session revoked', code: '401' },
    });
  });
});
