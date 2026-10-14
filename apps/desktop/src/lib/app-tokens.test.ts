import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/settings', () => ({
  getSettings: () => ({ nodeUrl: 'http://localhost:2528' }),
}));

let desktopAccess: string | null;
vi.mock('./token-storage', () => ({
  getAccessToken: () => desktopAccess,
}));

const fetchMock = vi.fn();
const brokerAccessToken = vi.fn();
vi.mock('./token-broker', () => ({
  unpatchedFetch: () => fetchMock,
  brokerAccessToken: (...a: unknown[]) => brokerAccessToken(...a),
}));

/** What the node has installed, as the desktop's cache lists it. */
let installed: { id: string; package?: string; metadata?: unknown }[] = [];
vi.mock('../utils/installedAppsCache', () => ({
  listInstalledApps: async () => ({ data: installed }),
}));
vi.mock('../utils/appUtils', () => ({ decodeMetadata: (m: unknown) => m }));

const HYPERFEED_ID = '7Vp3x1Rn9qWkL2mBcD4fGh6JtYz8sAeUoQiP5uNvXyZ';
const hyperfeed = (frontend: string) => ({
  id: HYPERFEED_ID,
  package: 'com.calimero.hyperfeed',
  metadata: { links: { frontend } },
});

type AppTokens = typeof import('./app-tokens');
let mod: AppTokens;

/** An unsigned JWT whose `exp` is `secondsFromNow` away. */
function jwt(label: string, secondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow, l: label }));
  return `h.${payload}.s`;
}

function ok(pair: { access_token: string; refresh_token: string }) {
  return new Response(JSON.stringify({ data: pair }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function calls(path: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));
}

beforeEach(async () => {
  vi.clearAllMocks();
  installed = [];
  desktopAccess = 'desktop-root-access';
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.resetModules();
  mod = await import('./app-tokens');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('appAccessToken', () => {
  it('mints a client key with app grants only — no admin, no keys — using the desktop session', async () => {
    const minted = { access_token: jwt('a1', 3600), refresh_token: 'r1' };
    fetchMock.mockResolvedValueOnce(ok(minted));

    await expect(mod.appAccessToken('app-drive')).resolves.toBe(minted.access_token);

    const [url, init] = calls('/admin/client-key')[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:2528/admin/client-key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer desktop-root-access');
    const body = JSON.parse(init.body as string);
    expect(body.permissions).toEqual([...mod.APP_TOKEN_PERMISSIONS]);
    expect(body.permissions).not.toContain('admin');
    expect(body.permissions.some((p: string) => p === 'keys' || p.startsWith('keys:'))).toBe(false);
    // core's GenerateClientKeyRequest is deny_unknown_fields.
    expect(Object.keys(body).sort()).toEqual(['context_id', 'context_identity', 'permissions']);
  });

  it('never returns the desktop`s own token', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));
    await expect(mod.appAccessToken('app-drive')).resolves.not.toBe('desktop-root-access');
  });

  it('reuses a fresh stored pair without touching the network', async () => {
    const minted = { access_token: jwt('a1', 3600), refresh_token: 'r1' };
    fetchMock.mockResolvedValueOnce(ok(minted));
    await mod.appAccessToken('app-drive');
    fetchMock.mockClear();

    await expect(mod.appAccessToken('app-drive')).resolves.toBe(minted.access_token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rotates the APP`s pair (not the desktop`s) when its access token expired', async () => {
    const stale = { access_token: jwt('a1', -10), refresh_token: 'r1' };
    const rotated = { access_token: jwt('a2', 3600), refresh_token: 'r2' };
    fetchMock.mockResolvedValueOnce(ok(stale)).mockResolvedValueOnce(ok(rotated));
    await mod.appAccessToken('app-drive');

    await expect(mod.appAccessToken('app-drive')).resolves.toBe(rotated.access_token);
    const [, init] = calls('/auth/refresh')[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(stale);
  });

  it('mints afresh when the app pair`s family is dead', async () => {
    const stale = { access_token: jwt('a1', -10), refresh_token: 'r1' };
    const fresh = { access_token: jwt('a3', 3600), refresh_token: 'r3' };
    fetchMock
      .mockResolvedValueOnce(ok(stale))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ok(fresh));
    await mod.appAccessToken('app-drive');

    await expect(mod.appAccessToken('app-drive')).resolves.toBe(fresh.access_token);
    expect(calls('/admin/client-key')).toHaveLength(2);
  });

  it('keeps apps apart: each slot gets its own key', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: jwt('drive', 3600), refresh_token: 'rd' }))
      .mockResolvedValueOnce(ok({ access_token: jwt('chat', 3600), refresh_token: 'rc' }));

    const drive = await mod.appAccessToken('app-drive');
    const chat = await mod.appAccessToken('launcher-chat');
    expect(drive).not.toBe(chat);
    expect(calls('/admin/client-key')).toHaveLength(2);
  });

  it('collapses a burst for one slot into a single mint', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));

    await Promise.all([mod.appAccessToken('app-x'), mod.appAccessToken('app-x'), mod.appAccessToken('app-x')]);
    expect(calls('/admin/client-key')).toHaveLength(1);
  });

  it('retries the mint once after rotating a stale desktop session', async () => {
    brokerAccessToken.mockResolvedValue('desktop-rotated');
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));

    await mod.appAccessToken('app-x');
    const [, init] = calls('/admin/client-key')[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer desktop-rotated');
  });

  it('refuses when the desktop is not logged in', async () => {
    desktopAccess = null;
    await expect(mod.appAccessToken('app-x')).rejects.toThrow('Desktop is not authenticated');
  });
});

// Hyperfeed installs apps and deletes feeds for you: it acts as the admin
// dashboard does, and only it, only from its own frontend.
describe('trusted apps', () => {
  const mintedPermissions = (i = 0) =>
    JSON.parse((calls('/admin/client-key')[i] as [string, RequestInit])[1].body as string).permissions;

  it('mints full access for Hyperfeed at its own origin, in a window and in its launcher', async () => {
    installed = [hyperfeed('https://hyperfeed-two.vercel.app')];
    fetchMock.mockImplementation(async () => ok({ access_token: jwt('hf', 3600), refresh_token: 'rh' }));

    await mod.appAccessToken(`app-${HYPERFEED_ID}`);
    await mod.appAccessToken(`launcher-${HYPERFEED_ID}`);

    expect(mintedPermissions(0)).toEqual(['admin']);
    expect(mintedPermissions(1)).toEqual(['admin']);
    expect(mintedPermissions(0)).not.toContain('keys');
  });

  it('gives the plain app set to the package served from anywhere else', async () => {
    installed = [hyperfeed('https://hyperfeed.evil.example')];
    fetchMock.mockImplementation(async () => ok({ access_token: jwt('hf', 3600), refresh_token: 'rh' }));

    await mod.appAccessToken(`app-${HYPERFEED_ID}`);
    expect(mintedPermissions()).toEqual([...mod.APP_TOKEN_PERMISSIONS]);
  });

  it('gives the plain app set to any other package at that origin', async () => {
    installed = [{ ...hyperfeed('https://hyperfeed-two.vercel.app'), package: 'com.example.copycat' }];
    fetchMock.mockImplementation(async () => ok({ access_token: jwt('hf', 3600), refresh_token: 'rh' }));

    await mod.appAccessToken(`app-${HYPERFEED_ID}`);
    expect(mintedPermissions()).toEqual([...mod.APP_TOKEN_PERMISSIONS]);
  });

  it('replaces a scoped pair kept from before, instead of rotating it', async () => {
    const scoped = { access_token: jwt('old', 3600), refresh_token: 'r-old' };
    fetchMock.mockResolvedValueOnce(ok(scoped));
    await mod.appAccessToken(`app-${HYPERFEED_ID}`); // not installed yet: the plain set

    installed = [hyperfeed('https://hyperfeed-two.vercel.app')];
    const full = { access_token: jwt('new', 3600), refresh_token: 'r-new' };
    fetchMock.mockResolvedValueOnce(ok(full));

    await expect(mod.appAccessToken(`app-${HYPERFEED_ID}`)).resolves.toBe(full.access_token);
    expect(mintedPermissions(1)).toEqual(['admin']);
    expect(calls('/auth/refresh')).toHaveLength(0);
  });

  it('reads the app id off a slot, cross-node suffix and all', () => {
    expect(mod.appIdOfSlot(`app-${HYPERFEED_ID}`)).toBe(HYPERFEED_ID);
    expect(mod.appIdOfSlot(`app-${HYPERFEED_ID}-nabc123`)).toBe(HYPERFEED_ID);
    expect(mod.appIdOfSlot(`launcher-${HYPERFEED_ID}`)).toBe(HYPERFEED_ID);
    expect(mod.appIdOfSlot('app-drive-example-com')).toBeNull();
    expect(mod.appIdOfSlot(`main-${HYPERFEED_ID}`)).toBeNull();
  });
});
