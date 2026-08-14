import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const homeDir = vi.fn();
vi.mock('@tauri-apps/api/path', () => ({ homeDir: (...a: unknown[]) => homeDir(...a) }));

const detectRunningMerodNodes = vi.fn();
const stopMerodByPid = vi.fn();
const deleteCalimeroDataDir = vi.fn();
vi.mock('./merod', () => ({
  detectRunningMerodNodes: (...a: unknown[]) => detectRunningMerodNodes(...a),
  stopMerodByPid: (...a: unknown[]) => stopMerodByPid(...a),
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

import { hardReset, wipeClientState, previewHardReset } from './hardReset';
import type { RunningMerodNode } from './merod';

const CLOUD_TOKEN = 'the-mdma-session-token';
const HOME = '/Users/alice';

/** A node whose data dir (home_dir/node_name) sits under HOME/.calimero. */
function nodeUnder(overrides: Partial<RunningMerodNode> = {}): RunningMerodNode {
  return {
    pid: 4242,
    node_name: 'default',
    port: 2428,
    home_dir: `${HOME}/.calimero`,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.localStorage = fakeStorage();
  globalThis.sessionStorage = fakeStorage();
  settings = { cloudIdToken: CLOUD_TOKEN, embeddedNodeDataDir: '~/.calimero' };
  homeDir.mockResolvedValue(HOME);
  detectRunningMerodNodes.mockResolvedValue([]);
  stopMerodByPid.mockResolvedValue('stopped');
  deleteCalimeroDataDir.mockResolvedValue('Directory did not exist (nothing to delete)');
  invoke.mockResolvedValue('ok');
});

/** Order of the native reset commands the run invoked. */
function nativeCalls(): string[] {
  return invoke.mock.calls.map((c) => c[0] as string);
}

/** Unique dirs passed to deleteCalimeroDataDir, in first-seen order - the delete
 * calls repeat per dir (delete + gone-now + gone-a-moment-later verification). */
function deletedDirsInOrder(): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const [dir] of deleteCalimeroDataDir.mock.calls as [string][]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      order.push(dir);
    }
  }
  return order;
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

    expect(deletedDirsInOrder()).toEqual(['~/custom-node', '~/.calimero']);
  });

  it('does not delete the default dir twice when it is the configured one', async () => {
    await hardReset();

    expect(deletedDirsInOrder()).toEqual(['~/.calimero']);
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

  it('is scoped by path: stops a node under a target dir even if the app never started it', async () => {
    const node = nodeUnder({ pid: 777, node_name: 'default' });
    // Reported once (enumeration), gone on every re-poll after the stop.
    detectRunningMerodNodes.mockResolvedValueOnce([node]).mockResolvedValue([]);

    await hardReset();

    expect(stopMerodByPid).toHaveBeenCalledWith(777);
  });

  it('does not stop a node on an unrelated home directory', async () => {
    const unrelated = nodeUnder({ pid: 999, node_name: 'other', home_dir: '/Users/alice/somewhere-else' });
    detectRunningMerodNodes.mockResolvedValue([unrelated]);

    await hardReset();

    expect(stopMerodByPid).not.toHaveBeenCalled();
    // Unrelated node, no live writer under the target paths - delete proceeds.
    expect(deleteCalimeroDataDir).toHaveBeenCalled();
  });

  it('keeps going when a targeted node refuses to stop gracefully - the delete is the real test', async () => {
    const node = nodeUnder();
    // Reported once, then gone on every re-poll: stop "succeeded" even though
    // stopMerodByPid itself rejected.
    detectRunningMerodNodes.mockResolvedValueOnce([node]).mockResolvedValue([]);
    stopMerodByPid.mockRejectedValue(new Error('kill failed'));

    await hardReset();

    expect(deleteCalimeroDataDir).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('clear_app_sessions');
  });

  it('aborts the delete when a live node under a target path never stops, and names it', async () => {
    const node = nodeUnder({ pid: 555, node_name: 'stubborn' });
    // Always reported as running, no matter how many times the scan re-polls.
    detectRunningMerodNodes.mockResolvedValue([node]);

    let error: unknown;
    try {
      // A short deadline: this asserts the give-up path, not how long it waits.
      // Burning the real timeout made the test flaky against vitest's own limit.
      await hardReset({ stopTimeoutMs: 50 });
    } catch (err) {
      error = err;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain('stubborn');
    expect(message).toContain('555');

    // Never delete under a live writer.
    expect(deleteCalimeroDataDir).not.toHaveBeenCalled();
  });

  it('polls the running-node scan to verify a stop, not in-memory status', async () => {
    // Regression: the old wait loop read getMerodStatus(), the in-memory state
    // the kill step had just cleared, so it reported "stopped" on the first
    // tick regardless of reality. The scan must be re-polled until it agrees.
    const node = nodeUnder({ pid: 321 });
    detectRunningMerodNodes
      .mockResolvedValueOnce([node]) // initial enumeration
      .mockResolvedValueOnce([node]) // still there on the first re-poll
      .mockResolvedValue([]); // gone on the second re-poll

    await hardReset();

    expect(detectRunningMerodNodes.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(deleteCalimeroDataDir).toHaveBeenCalled();
  });

  it('re-checks for a live node immediately before deleting each path, aborting if one appeared', async () => {
    const node = nodeUnder({ pid: 111, node_name: 'late-starter' });
    // Nothing running during the initial stop/verify phase...
    detectRunningMerodNodes.mockResolvedValue([]);

    // ...but by the time the delete loop re-checks the second (default) dir,
    // a node has appeared under it.
    settings = { embeddedNodeDataDir: '~/custom-node' };
    let deleteCalls = 0;
    deleteCalimeroDataDir.mockImplementation(async () => {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        detectRunningMerodNodes.mockResolvedValue([{ ...node, home_dir: HOME + '/.calimero' }]);
      }
      return 'Directory did not exist (nothing to delete)';
    });

    await expect(hardReset()).rejects.toThrow(/late-starter/);

    // The first (custom) dir was deleted before the late node showed up; the
    // second (default) dir must not have been.
    expect(deletedDirsInOrder()).toEqual(['~/custom-node']);
  });

  it('aborts when a wiped path is not actually gone (delete silently failed)', async () => {
    deleteCalimeroDataDir.mockResolvedValue('Deleted /Users/alice/.calimero');

    await expect(hardReset()).rejects.toThrow(/still|reappeared/i);
  });

  it('aborts when a path reappears a moment after being wiped - a surviving writer repopulating it', async () => {
    let calls = 0;
    deleteCalimeroDataDir.mockImplementation(async () => {
      calls += 1;
      // Delete itself, and the immediate recheck, report gone; the delayed
      // recheck finds a 10MB file has reappeared - exactly the real incident.
      return calls <= 2 ? 'Directory did not exist (nothing to delete)' : 'Deleted /Users/alice/.calimero';
    });

    await expect(hardReset()).rejects.toThrow(/reappeared/i);
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

describe('previewHardReset', () => {
  it('reports every directory that would be deleted, disclosing the always-included default', async () => {
    settings = { embeddedNodeDataDir: '~/custom-node' };

    const preview = await previewHardReset();

    expect(preview.dirsToDelete).toEqual(['~/custom-node', '~/.calimero']);
  });

  it('reports every node in scope, with home, node name and pid', async () => {
    const node = nodeUnder({ pid: 42, node_name: 'default', home_dir: `${HOME}/.calimero` });
    const unrelated = nodeUnder({ pid: 43, node_name: 'other', home_dir: '/Users/alice/elsewhere' });
    detectRunningMerodNodes.mockResolvedValue([node, unrelated]);

    const preview = await previewHardReset();

    expect(preview.nodesToStop).toEqual([node]);
  });

  it('does not stop or delete anything - it only reports', async () => {
    detectRunningMerodNodes.mockResolvedValue([nodeUnder()]);

    await previewHardReset();

    expect(stopMerodByPid).not.toHaveBeenCalled();
    expect(deleteCalimeroDataDir).not.toHaveBeenCalled();
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
