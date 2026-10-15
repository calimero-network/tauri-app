import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../utils/settings', () => ({
  getSettings: () => ({ nodeUrl: 'http://localhost:2528' }),
}));

let desktopAccess: string | null;
let desktopRefresh: string | null;
vi.mock('./token-storage', () => ({
  getAccessToken: () => desktopAccess,
  getRefreshToken: () => desktopRefresh,
  clearAccessToken: () => void (desktopAccess = null),
  clearRefreshToken: () => void (desktopRefresh = null),
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

const HYPERFEED = '7Vp3x1Rn9qWkL2mBcD4fGh6JtYz8sAeUoQiP5uNvXyZ';
const hyperfeed = (frontend: string) => ({
  id: HYPERFEED,
  package: 'com.calimero.hyperfeed',
  metadata: { links: { frontend } },
});

type AppTokens = typeof import('./app-tokens');

const APP ='FsP2jwzu5bJ9KnXzM1wQzWyCdQvjDu4YNtK7QFbXnTq';
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
  vi.resetAllMocks();
  installed = [];
  desktopAccess = 'desktop-root-access';
  desktopRefresh = 'desktop-root-refresh';
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

    await expect(mod.appAccessToken('app-drive', APP)).resolves.toBe(minted.access_token);

    const [url, init] = calls('/admin/client-key')[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:2528/admin/client-key');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer desktop-root-access');
    const body = JSON.parse(init.body as string);
    expect(body.permissions).toEqual([...mod.APP_TOKEN_PERMISSIONS]);
    expect(body.permissions).not.toContain('admin');
    expect(body.permissions.some((p: string) => p === 'keys' || p.startsWith('keys:'))).toBe(false);
    expect(body.application_id).toBe(APP);
    // core's GenerateClientKeyRequest is deny_unknown_fields.
    expect(Object.keys(body).sort()).toEqual(['application_id', 'context_id', 'context_identity', 'permissions']);
  });

  it('grants no umbrella and no blob listing', () => {
    for (const umbrella of ['blob', 'namespace', 'group', 'context', 'application']) {
      expect(mod.APP_TOKEN_PERMISSIONS).not.toContain(umbrella);
    }
    expect(mod.APP_TOKEN_PERMISSIONS).not.toContain('blob:list');
    expect(mod.APP_TOKEN_PERMISSIONS).toEqual(expect.arrayContaining(['blob:add', 'blob:get', 'blob:remove']));
  });

  it('binds a launcher slot to the application it names', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: jwt('l1', 3600), refresh_token: 'rl' }));
    await mod.appAccessToken(`launcher-${APP}`);
    const [, init] = calls('/admin/client-key')[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).application_id).toBe(APP);
  });

  it('mints nothing for a slot whose application is unknown', async () => {
    await expect(mod.appAccessToken('app-localhost-5173')).rejects.toThrow('No application is known');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-mints for the slot`s remembered application when its family is dead', async () => {
    const stale = { access_token: jwt('a1', -10), refresh_token: 'r1' };
    const fresh = { access_token: jwt('a2', 3600), refresh_token: 'r2' };
    fetchMock
      .mockResolvedValueOnce(ok(stale))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ok(fresh));
    await mod.appAccessToken('app-drive', APP);

    // A broker refresh names only the slot.
    await expect(mod.appAccessToken('app-drive')).resolves.toBe(fresh.access_token);
    const [, init] = calls('/admin/client-key')[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).application_id).toBe(APP);
  });

  it('never reuses a pair minted for another application', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }))
      .mockResolvedValueOnce(ok({ access_token: jwt('b1', 3600), refresh_token: 'r2' }));
    await mod.appAccessToken('app-x', APP);
    await mod.appAccessToken('app-x', 'OtherApp');

    const minted = calls('/admin/client-key').map(([, init]) => JSON.parse((init as RequestInit).body as string).application_id);
    expect(minted).toEqual([APP, 'OtherApp']);
    expect(calls('/auth/refresh')).toHaveLength(0);
  });

  it('drops a stored pair minted before keys were bound', async () => {
    localStorage.setItem(
      'calimero_app_token_slots',
      JSON.stringify({ 'app-x': { access_token: jwt('old', 3600), refresh_token: 'r0' } }),
    );
    fetchMock.mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));
    await expect(mod.appAccessToken('app-x', APP)).resolves.not.toBe(jwt('old', 3600));
    expect(calls('/admin/client-key')).toHaveLength(1);
    expect(calls('/auth/refresh')).toHaveLength(0);
  });

  it('mints nothing for an application id the node would not bind', async () => {
    for (const bad of ['launcher-', 'launcher-a b']) {
      await expect(mod.appAccessToken(bad)).rejects.toThrow('No application is known');
    }
    await expect(mod.appAccessToken('app-x', 'app<x>')).rejects.toThrow('No application is known');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remembers a window`s application across a logout', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }))
      .mockResolvedValueOnce(ok({ access_token: jwt('a2', 3600), refresh_token: 'r2' }));
    await mod.appAccessToken('app-drive', APP);
    localStorage.removeItem('calimero_app_token_slots');

    await mod.appAccessToken('app-drive');
    const [, init] = calls('/admin/client-key')[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string).application_id).toBe(APP);
  });

  it('keeps concurrent calls for different applications apart', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }))
      .mockResolvedValueOnce(ok({ access_token: jwt('b1', 3600), refresh_token: 'r2' }));
    await Promise.all([mod.appAccessToken('app-x', APP), mod.appAccessToken('app-x', 'OtherApp')]);
    const minted = calls('/admin/client-key').map(([, init]) => JSON.parse((init as RequestInit).body as string).application_id);
    expect(minted.sort()).toEqual([APP, 'OtherApp'].sort());
  });

  it('never returns the desktop`s own token', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));
    await expect(mod.appAccessToken('app-drive', APP)).resolves.not.toBe('desktop-root-access');
  });

  it('reuses a fresh stored pair without touching the network', async () => {
    const minted = { access_token: jwt('a1', 3600), refresh_token: 'r1' };
    fetchMock.mockResolvedValueOnce(ok(minted));
    await mod.appAccessToken('app-drive', APP);
    fetchMock.mockClear();

    await expect(mod.appAccessToken('app-drive', APP)).resolves.toBe(minted.access_token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rotates the APP`s pair (not the desktop`s) when its access token expired', async () => {
    const stale = { access_token: jwt('a1', -10), refresh_token: 'r1' };
    const rotated = { access_token: jwt('a2', 3600), refresh_token: 'r2' };
    fetchMock.mockResolvedValueOnce(ok(stale)).mockResolvedValueOnce(ok(rotated));
    await mod.appAccessToken('app-drive', APP);

    await expect(mod.appAccessToken('app-drive', APP)).resolves.toBe(rotated.access_token);
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
    await mod.appAccessToken('app-drive', APP);

    await expect(mod.appAccessToken('app-drive', APP)).resolves.toBe(fresh.access_token);
    expect(calls('/admin/client-key')).toHaveLength(2);
  });

  it('keeps apps apart: each slot gets its own key', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: jwt('drive', 3600), refresh_token: 'rd' }))
      .mockResolvedValueOnce(ok({ access_token: jwt('chat', 3600), refresh_token: 'rc' }));

    const drive = await mod.appAccessToken('app-drive', APP);
    const chat = await mod.appAccessToken('launcher-chat');
    expect(drive).not.toBe(chat);
    expect(calls('/admin/client-key')).toHaveLength(2);
  });

  it('collapses a burst for one slot into a single mint', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));

    await Promise.all([mod.appAccessToken('app-x', APP), mod.appAccessToken('app-x', APP), mod.appAccessToken('app-x', APP)]);
    expect(calls('/admin/client-key')).toHaveLength(1);
  });

  it('retries the mint once after rotating a stale desktop session', async () => {
    brokerAccessToken.mockResolvedValue('desktop-rotated');
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));

    await mod.appAccessToken('app-x', APP);
    const [, init] = calls('/admin/client-key')[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer desktop-rotated');
  });

  it('refuses when the desktop is not logged in', async () => {
    desktopAccess = null;
    await expect(mod.appAccessToken('app-x', APP)).rejects.toThrow('Desktop is not authenticated');
  });
});

// Hyperfeed installs apps and deletes feeds for you: it acts as the admin
// dashboard does, and only it, only from its own frontend.
describe('trusted apps', () => {
  const minted = (i = 0) =>
    JSON.parse((calls('/admin/client-key')[i] as [string, RequestInit])[1].body as string);
  const mintEach = () =>
    fetchMock.mockImplementation(async () => ok({ access_token: jwt('hf', 3600), refresh_token: 'rh' }));

  it('mints full access for Hyperfeed at its own origin, still bound to its application', async () => {
    installed = [hyperfeed('https://hyperfeed.me')];
    mintEach();

    await mod.appAccessToken('app-hyperfeed', HYPERFEED);
    await mod.appAccessToken(`launcher-${HYPERFEED}`);

    for (const i of [0, 1]) {
      expect(minted(i).permissions).toEqual(['admin']);
      expect(minted(i).application_id).toBe(HYPERFEED);
    }
  });

  it('gives the plain app set to the package served from anywhere else', async () => {
    installed = [hyperfeed('https://hyperfeed.evil.example')];
    mintEach();

    await mod.appAccessToken('app-hyperfeed', HYPERFEED);
    expect(minted().permissions).toEqual([...mod.APP_TOKEN_PERMISSIONS]);
  });

  it('gives the plain app set to any other package at that origin', async () => {
    installed = [{ ...hyperfeed('https://hyperfeed-two.vercel.app'), package: 'com.example.copycat' }];
    mintEach();

    await mod.appAccessToken('app-hyperfeed', HYPERFEED);
    expect(minted().permissions).toEqual([...mod.APP_TOKEN_PERMISSIONS]);
  });

  it('replaces a scoped pair kept from before, instead of rotating it', async () => {
    const scoped = { access_token: jwt('old', 3600), refresh_token: 'r-old' };
    fetchMock.mockResolvedValueOnce(ok(scoped));
    await mod.appAccessToken('app-hyperfeed', HYPERFEED); // not installed yet: the plain set

    installed = [hyperfeed('https://hyperfeed-two.vercel.app')];
    const full = { access_token: jwt('new', 3600), refresh_token: 'r-new' };
    fetchMock.mockResolvedValueOnce(ok(full));

    await expect(mod.appAccessToken('app-hyperfeed', HYPERFEED)).resolves.toBe(full.access_token);
    expect(minted(1).permissions).toEqual(['admin']);
    expect(calls('/auth/refresh')).toHaveLength(0);
  });

  it('trusts www.hyperfeed.me and, until bundles move, the vercel.app frontend', async () => {
    mintEach();
    for (const [i, frontend] of ['https://www.hyperfeed.me', 'https://hyperfeed-two.vercel.app'].entries()) {
      installed = [hyperfeed(frontend)];
      await mod.appAccessToken(`app-hyperfeed-${i}`, HYPERFEED);
      expect(minted(i).permissions).toEqual(['admin']);
    }
  });

  it('gives the plain app set to a look-alike of hyperfeed.me', async () => {
    installed = [hyperfeed('https://hyperfeed.me.evil.example')];
    mintEach();

    await mod.appAccessToken('app-hyperfeed', HYPERFEED);
    expect(minted().permissions).toEqual([...mod.APP_TOKEN_PERMISSIONS]);
  });
});

describe('retiring app keys', () => {
  /** The refresh tokens presented to `/auth/logout`, which revokes a client key. */
  const retired = () =>
    calls('/auth/logout').map(([, init]) => JSON.parse((init as RequestInit).body as string).refresh_token);

  async function openTwoApps() {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: jwt('drive', 3600), refresh_token: 'rd' }))
      .mockResolvedValueOnce(ok({ access_token: jwt('chat', 3600), refresh_token: 'rc' }));
    await mod.appAccessToken('app-drive', APP);
    await mod.appAccessToken('launcher-chat');
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  }

  it('retires a closed window`s key and keeps the others', async () => {
    await openTwoApps();

    await mod.retireAppToken('app-drive');

    expect(retired()).toEqual(['rd']);
    fetchMock.mockClear();
    await mod.appAccessToken('launcher-chat');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints afresh for a window reopened after its key was retired', async () => {
    await openTwoApps();
    await mod.retireAppToken('app-drive');
    fetchMock.mockResolvedValueOnce(ok({ access_token: jwt('drive2', 3600), refresh_token: 'rd2' }));

    await mod.appAccessToken('app-drive', APP);

    expect(calls('/admin/client-key')).toHaveLength(1);
  });

  it('logs out of the node: every app key and the desktop`s session', async () => {
    await openTwoApps();

    await mod.logOutOfNode();

    expect(retired().sort()).toEqual(['desktop-root-refresh', 'rc', 'rd']);
    expect(desktopAccess).toBeNull();
    expect(desktopRefresh).toBeNull();
    expect(localStorage.getItem('calimero_app_token_slots')).toBeNull();
  });

  it('forgets the keys even when the node cannot be reached', async () => {
    await openTwoApps();
    fetchMock.mockRejectedValue(new TypeError('offline'));

    await expect(mod.logOutOfNode()).resolves.toBeUndefined();

    expect(desktopRefresh).toBeNull();
    expect(localStorage.getItem('calimero_app_token_slots')).toBeNull();
  });

  it('gives up on a node that does not answer instead of hanging the logout', async () => {
    await openTwoApps();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    vi.useFakeTimers();
    try {
      const done = mod.logOutOfNode();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retires the pair it replaces with one for another application', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }))
      .mockResolvedValueOnce(ok({ access_token: jwt('b1', 3600), refresh_token: 'r2' }));
    await mod.appAccessToken('app-x', APP);

    await mod.appAccessToken('app-x', 'OtherApp');

    expect(retired()).toEqual(['r1']);
  });
});

describe('installedFrontendUrl', () => {
  it('names the frontend the node has the app installed at', async () => {
    installed = [
      { id: APP, package: 'com.calimero.chat', metadata: { links: { frontend: 'https://mero-chat-pwa.vercel.app' } } },
    ];
    await expect(mod.installedFrontendUrl(APP)).resolves.toBe('https://mero-chat-pwa.vercel.app');
  });

  it('names none for an app the node does not list, or one with no frontend', async () => {
    installed = [{ id: APP, package: 'com.calimero.chat', metadata: { links: {} } }];
    await expect(mod.installedFrontendUrl(APP)).resolves.toBeUndefined();
    await expect(mod.installedFrontendUrl('someone-else')).resolves.toBeUndefined();
  });
});
