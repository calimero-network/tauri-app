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

type AppTokens = typeof import('./app-tokens');

const APP = 'FsP2jwzu5bJ9KnXzM1wQzWyCdQvjDu4YNtK7QFbXnTq';
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
  });

  it('drops a stored pair minted before keys were bound', async () => {
    localStorage.setItem(
      'calimero_app_token_slots',
      JSON.stringify({ 'app-x': { access_token: jwt('old', 3600), refresh_token: 'r0' } }),
    );
    fetchMock.mockResolvedValueOnce(ok({ access_token: jwt('a1', 3600), refresh_token: 'r1' }));
    await expect(mod.appAccessToken('app-x', APP)).resolves.not.toBe(jwt('old', 3600));
    expect(calls('/admin/client-key')).toHaveLength(1);
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
