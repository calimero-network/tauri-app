import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const stopMerod = vi.fn();
const killAllMerodProcesses = vi.fn();
const getMerodStatus = vi.fn();
const deleteCalimeroDataDir = vi.fn();
vi.mock('./merod', () => ({
  stopMerod: (...a: unknown[]) => stopMerod(...a),
  killAllMerodProcesses: (...a: unknown[]) => killAllMerodProcesses(...a),
  getMerodStatus: (...a: unknown[]) => getMerodStatus(...a),
  deleteCalimeroDataDir: (...a: unknown[]) => deleteCalimeroDataDir(...a),
}));

const revokeMdmaSession = vi.fn();
vi.mock('./cloudAuth', () => ({
  revokeMdmaSession: (...a: unknown[]) => revokeMdmaSession(...a),
}));

// getSettings is stubbed, but clearAllAppData is the REAL one: that it clears the
// whole storage silo (not a stale allowlist of keys) is part of what's under test.
let settings: Record<string, unknown> = {};
vi.mock('./settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settings')>()),
  getSettings: () => settings,
}));

/** Minimal in-memory Storage for the node test environment. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

import { hardReset, wipeClientState } from './hardReset';

const CLOUD_TOKEN = 'the-mdma-session-token';

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.localStorage = fakeStorage();
  globalThis.sessionStorage = fakeStorage();
  settings = { cloudIdToken: CLOUD_TOKEN, embeddedNodeDataDir: '~/.calimero' };
  getMerodStatus.mockResolvedValue({ running: false });
  deleteCalimeroDataDir.mockResolvedValue('Deleted');
  invoke.mockResolvedValue('ok');
});

/** Order of the native reset commands the run invoked. */
function nativeCalls(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

describe('hardReset', () => {
  it('clears the webview session data, not just the data directory', async () => {
    await hardReset();

    // The regression: deleting ~/.calimero left every app origin's localStorage
    // (and its access token) on disk, so reopening an app resumed the session.
    expect(invoke).toHaveBeenCalledWith('clear_app_sessions');
  });

  it('removes the launchers, and only after the shells running from them are killed', async () => {
    await hardReset();

    // The apps the launchers point at lived in the deleted data dir, and their
    // capability tokens would otherwise keep brokering fresh tokens.
    expect(nativeCalls()).toEqual(['clear_app_sessions', 'remove_app_launchers']);
  });

  it('deletes the configured data dir and the default one, deduped', async () => {
    settings = { embeddedNodeDataDir: '~/custom-node' };

    await hardReset();

    expect(deleteCalimeroDataDir.mock.calls.map((c) => c[0])).toEqual([
      '~/custom-node',
      '~/.calimero',
    ]);
  });

  it('does not delete the default dir twice when it is the configured one', async () => {
    await hardReset();

    expect(deleteCalimeroDataDir.mock.calls.map((c) => c[0])).toEqual(['~/.calimero']);
  });

  it('revokes the cloud session server-side before dropping the token', async () => {
    await hardReset();

    expect(revokeMdmaSession).toHaveBeenCalledWith(CLOUD_TOKEN);
  });

  it('wipes every localStorage key, including ones no allowlist knew about', async () => {
    localStorage.setItem('calimero-desktop-settings', '{}');
    localStorage.setItem('calimero-context-keys', '{}');
    localStorage.setItem('calimero_oauth_pending_state', '{}');
    localStorage.setItem('calimero_access_token', 'at');
    sessionStorage.setItem('anything', 'x');

    await hardReset();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps going when the node refuses to stop — the delete is the real test', async () => {
    stopMerod.mockRejectedValue(new Error('not running'));
    killAllMerodProcesses.mockRejectedValue(new Error('kill failed'));

    await hardReset();

    expect(deleteCalimeroDataDir).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('clear_app_sessions');
  });

  it('leaves client state untouched when a data dir survives, so the user can retry', async () => {
    localStorage.setItem('calimero-desktop-settings', '{}');
    deleteCalimeroDataDir.mockRejectedValue(new Error('Failed to delete directory'));

    await expect(hardReset()).rejects.toThrow('Failed to delete directory');

    expect(localStorage.getItem('calimero-desktop-settings')).toBe('{}');
    expect(invoke).not.toHaveBeenCalled();
    expect(revokeMdmaSession).not.toHaveBeenCalled();
  });
});

describe('wipeClientState', () => {
  it('still clears local storage when the native reset fails', async () => {
    localStorage.setItem('calimero-desktop-settings', '{}');
    invoke.mockRejectedValue(new Error('main window is gone'));

    await expect(wipeClientState()).resolves.toBe(false);

    expect(localStorage.length).toBe(0);
  });

  it('keeps the launchers unless asked to remove them (the softer reset)', async () => {
    await expect(wipeClientState()).resolves.toBe(true);

    // A launcher is a dock icon the user placed; "reset settings" must not bin it.
    expect(nativeCalls()).toEqual(['clear_app_sessions']);
  });
});
