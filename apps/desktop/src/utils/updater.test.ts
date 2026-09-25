import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock is hoisted — use vi.hoisted() so the mock vars are available when
// the factory runs.
const {
  mockDownloadAndInstall,
  mockDownload,
  mockInstall,
  mockClose,
  mockInvoke,
  mockRelaunch,
  mockCheck,
  mockGetVersion,
  mockStopMerod,
  mockDownloadAndReplace,
} = vi.hoisted(() => ({
  mockDownloadAndInstall: vi.fn().mockResolvedValue(undefined),
  mockDownload: vi.fn().mockResolvedValue(undefined),
  mockInstall: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockInvoke: vi.fn().mockResolvedValue(undefined),
  mockRelaunch: vi.fn().mockResolvedValue(undefined),
  // Tauri v2 plugin-updater: check() resolves to an Update handle or null.
  mockCheck: vi.fn(),
  mockGetVersion: vi.fn().mockResolvedValue('0.0.39'),
  mockStopMerod: vi.fn().mockResolvedValue('stopped'),
  mockDownloadAndReplace: vi.fn().mockResolvedValue({
    replaced: true,
    expected_version: '0.10.1-rc.43',
    current_version: 'merod 0.10.1-rc.43',
    message: 'merod updated',
  }),
}));

// A fake v2 Update handle. Its methods are delegated to the shared mocks so
// tests can assert on / reorder them.
const makeUpdate = (over: Record<string, unknown> = {}) => ({
  version: '0.0.40',
  currentVersion: '0.0.39',
  date: '2026-05-22',
  body: 'bug fixes',
  rawJson: {},
  downloadAndInstall: mockDownloadAndInstall,
  download: mockDownload,
  install: mockInstall,
  close: mockClose,
  ...over,
});

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mockCheck }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mockRelaunch }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mockGetVersion }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('./merod', () => ({
  stopMerod: mockStopMerod,
  downloadAndReplaceMerod: mockDownloadAndReplace,
}));

// Fake Tauri environment — vitest runs in node where `window` doesn't exist,
// so we define it on globalThis so that isTauri() returns true. Tauri v2
// injects __TAURI_INTERNALS__ regardless of withGlobalTauri.
(globalThis as any).window = { __TAURI_INTERNALS__: {} };

import {
  installUpdate,
  checkForUpdates,
  getCurrentVersion,
  startUpdateChecks,
  reflectUpdateInTray,
  downloadProgressReporter,
  CHECK_INTERVAL_MS,
  STARTUP_CHECK_DELAY_MS,
} from './updater';

beforeEach(() => {
  vi.clearAllMocks();
  mockDownloadAndInstall.mockResolvedValue(undefined);
  mockDownload.mockResolvedValue(undefined);
  mockInstall.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
  mockInvoke.mockResolvedValue(undefined);
  mockRelaunch.mockResolvedValue(undefined);
  // Default: an update is available (installUpdate tests rely on this).
  mockCheck.mockResolvedValue(makeUpdate());
  mockGetVersion.mockResolvedValue('0.0.39');
  mockStopMerod.mockResolvedValue('stopped');
  mockDownloadAndReplace.mockResolvedValue({
    replaced: true,
    expected_version: '0.10.1-rc.43',
    current_version: 'merod 0.10.1-rc.43',
    message: 'merod updated',
  });
});

describe('installUpdate', () => {
  it('runs the full sequence in order: download app → stop → download merod → install app → relaunch', async () => {
    const callOrder: string[] = [];
    mockDownload.mockImplementation(async () => { callOrder.push('download'); });
    mockStopMerod.mockImplementation(async () => { callOrder.push('stopMerod'); });
    mockDownloadAndReplace.mockImplementation(async () => {
      callOrder.push('downloadAndReplace');
      return { replaced: true, expected_version: '0.10.1-rc.43', current_version: 'merod 0.10.1-rc.43', message: '' };
    });
    mockInstall.mockImplementation(async () => { callOrder.push('install'); });
    mockRelaunch.mockImplementation(async () => { callOrder.push('relaunch'); });

    await installUpdate();

    expect(callOrder).toEqual(['download', 'stopMerod', 'downloadAndReplace', 'install', 'relaunch']);
  });

  // Regression: the node was stopped before the app update was even fetched,
  // so an offline or failed download left the user with a dead node.
  it('leaves the node running when the app update fails to download', async () => {
    mockDownload.mockRejectedValue('error sending request for url');
    await expect(installUpdate()).rejects.toBe('error sending request for url');
    expect(mockStopMerod).not.toHaveBeenCalled();
    expect(mockDownloadAndReplace).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('reports download progress as a percentage', async () => {
    mockDownload.mockImplementation(async (onEvent: (e: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 200 } });
      onEvent({ event: 'Progress', data: { chunkLength: 100 } });
      onEvent({ event: 'Progress', data: { chunkLength: 100 } });
      onEvent({ event: 'Finished' });
    });
    const statuses: string[] = [];
    await installUpdate((s) => statuses.push(s));
    expect(statuses).toContain('Downloading update... 50%');
    expect(statuses).toContain('Downloading update... 100%');
  });

  it('stops only the app\'s own tracked node(s), never every merod on the machine', async () => {
    // Regression: installUpdate force-killed every merod on the machine; it must
    // stop only the nodes this app tracks.
    await installUpdate();

    expect(mockStopMerod).toHaveBeenCalledOnce();
  });

  it('calls onStatus with each step label', async () => {
    const statuses: string[] = [];
    await installUpdate((s) => statuses.push(s));

    expect(statuses).toContain('Downloading update...');
    expect(statuses).toContain('Stopping nodes...');
    expect(statuses).toContain('Downloading merod binary...');
    expect(statuses).toContain('Installing app update...');
    expect(statuses).toContain('Restarting...');
  });

  it('proceeds even when stopMerod throws (node not running)', async () => {
    mockStopMerod.mockRejectedValue(new Error('not running'));
    await expect(installUpdate()).resolves.toBeUndefined();
    expect(mockDownloadAndReplace).toHaveBeenCalledOnce();
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });

  it('throws and does NOT relaunch when merod download fails (version mismatch)', async () => {
    mockDownloadAndReplace.mockRejectedValue(
      new Error("Version mismatch after replace: expected '0.10.1-rc.43', binary reports 'merod 0.10.1-rc.42'"),
    );
    await expect(installUpdate()).rejects.toThrow('Version mismatch');
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('throws and does NOT relaunch when Tauri returns a serialized error object with version mismatch', async () => {
    // Tauri invoke() rejects with a plain object {message, code}, not a JS Error instance
    mockDownloadAndReplace.mockRejectedValue({
      message: "Version mismatch after replace: expected '0.10.1-rc.43', binary reports 'merod 0.10.1-rc.42'",
      code: 'InternalError',
    });
    await expect(installUpdate()).rejects.toMatchObject({ message: expect.stringContaining('Version mismatch') });
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('warns and continues when merod download fails with a non-mismatch Tauri error object', async () => {
    mockDownloadAndReplace.mockRejectedValue({ message: 'network timeout', code: 'InternalError' });
    await expect(installUpdate()).resolves.toBeUndefined();
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });

  it('warns and continues when merod download fails with a non-object rejection (falls through to String(e))', async () => {
    mockDownloadAndReplace.mockRejectedValue(42);
    await expect(installUpdate()).resolves.toBeUndefined();
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });

  it('throws and does NOT relaunch when install fails', async () => {
    mockInstall.mockRejectedValue(new Error('no update package'));
    await expect(installUpdate()).rejects.toThrow('no update package');
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('still relaunches when binary was already at the correct version (replaced=false)', async () => {
    mockDownloadAndReplace.mockResolvedValue({
      replaced: false,
      expected_version: '0.10.1-rc.43',
      current_version: 'merod 0.10.1-rc.43',
      message: 'Binary is already at the expected version',
    });
    const statuses: string[] = [];
    await installUpdate((s) => statuses.push(s));
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });
});

describe('checkForUpdates', () => {
  // A platform with no entry in latest.json gets null from check(). Such a user
  // must never be blocked: there would be no update available to escape with.
  it('never reports mandatory when no update is available', async () => {
    mockCheck.mockResolvedValue(null);
    const result = await checkForUpdates();
    expect(result.available).toBe(false);
    expect(result.mandatory).toBeFalsy();
  });

  it('returns available=true with info when an update exists', async () => {
    mockCheck.mockResolvedValue(makeUpdate({ version: '0.0.40', date: '2026-05-22', body: 'bug fixes' }));
    const result = await checkForUpdates();
    expect(result.available).toBe(true);
    expect(result.info?.version).toBe('0.0.40');
  });
});

describe('checkForUpdates errors and sharing', () => {
  // The plugin rejects with a bare string. Dropping it to "Unknown error" hid
  // the only clue to why a check failed (offline, 404, bad signature, ...).
  it('keeps the text of a string rejection', async () => {
    mockCheck.mockRejectedValue('Could not fetch a valid release JSON from the remote');
    const result = await checkForUpdates();
    expect(result.available).toBe(false);
    expect(result.error).toBe('Could not fetch a valid release JSON from the remote');
  });

  it('keeps the message of a serialized error object', async () => {
    mockCheck.mockRejectedValue({ message: 'signature verification failed' });
    expect((await checkForUpdates()).error).toBe('signature verification failed');
  });

  it('shares one request between concurrent callers', async () => {
    let resolve!: (u: unknown) => void;
    mockCheck.mockReturnValue(new Promise((r) => { resolve = r; }));
    const a = checkForUpdates();
    const b = checkForUpdates();
    resolve(makeUpdate());
    const [ra, rb] = await Promise.all([a, b]);
    expect(mockCheck).toHaveBeenCalledOnce();
    expect(ra).toEqual(rb);
  });

  it('releases the previous update handle when a newer check replaces it', async () => {
    const first = makeUpdate({ close: vi.fn().mockResolvedValue(undefined) });
    mockCheck.mockResolvedValueOnce(first).mockResolvedValueOnce(makeUpdate());
    await checkForUpdates();
    await checkForUpdates();
    expect(first.close).toHaveBeenCalledOnce();
  });
});

describe('startUpdateChecks', () => {
  // A check resolves over several ticks (dynamic import, then check()); wait for
  // its result rather than guessing a tick count, so none leaks into the next test.
  const until = (assertion: () => void) => vi.waitFor(assertion);

  const fakeFocusTarget = () => {
    const listeners = new Set<() => void>();
    return {
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
      fire: () => listeners.forEach((fn) => fn()),
      size: () => listeners.size,
    };
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks shortly after startup, then on every interval', async () => {
    const results: string[] = [];
    const stop = startUpdateChecks((_, trigger) => results.push(trigger), { focusTarget: null });

    expect(mockCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);
    await until(() => expect(results).toEqual(['startup']));

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await until(() => expect(results).toEqual(['startup', 'interval']));
    stop();
  });

  it('re-checks on focus only once the last check has gone stale', async () => {
    let now = 1_000_000;
    const target = fakeFocusTarget();
    const results: string[] = [];
    const stop = startUpdateChecks((_, trigger) => results.push(trigger), {
      focusTarget: target,
      now: () => now,
    });
    await vi.advanceTimersByTimeAsync(STARTUP_CHECK_DELAY_MS);
    await until(() => expect(results).toEqual(['startup']));

    // Fresh: focusing again must not fire another request.
    target.fire();
    expect(mockCheck).toHaveBeenCalledTimes(1);

    // The window sat hidden and the interval timer was throttled.
    now += CHECK_INTERVAL_MS;
    target.fire();
    await until(() => expect(results).toEqual(['startup', 'focus']));
    expect(mockCheck).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops every timer and listener', async () => {
    const target = fakeFocusTarget();
    const onResult = vi.fn();
    const stop = startUpdateChecks(onResult, { focusTarget: target });
    stop();
    expect(target.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('reflectUpdateInTray', () => {
  it('offers the found version', async () => {
    await reflectUpdateInTray({ available: true, info: { version: '0.0.105', date: '', body: '' } });
    expect(mockInvoke).toHaveBeenCalledWith('set_update_menu_state', { state: 'available', version: '0.0.105' });
  });

  it('surfaces a failed check', async () => {
    await reflectUpdateInTray({ available: false, error: 'offline' });
    expect(mockInvoke).toHaveBeenCalledWith('set_update_menu_state', { state: 'failed', version: null });
  });

  it('marks an up-to-date result as current', async () => {
    await reflectUpdateInTray({ available: false });
    expect(mockInvoke).toHaveBeenCalledWith('set_update_menu_state', { state: 'current', version: null });
  });

  it('never throws when the tray cannot be updated', async () => {
    mockInvoke.mockRejectedValue(new Error('tray not ready'));
    await expect(reflectUpdateInTray({ available: false })).resolves.toBeUndefined();
  });

  it('does nothing outside Tauri', async () => {
    await reflectUpdateInTray({ available: false, unsupported: true });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe('downloadProgressReporter', () => {
  it('reports each whole percent once', () => {
    const statuses: string[] = [];
    const report = downloadProgressReporter((s) => statuses.push(s));
    report({ event: 'Started', data: { contentLength: 1000 } });
    report({ event: 'Progress', data: { chunkLength: 1 } });
    report({ event: 'Progress', data: { chunkLength: 1 } });
    report({ event: 'Progress', data: { chunkLength: 998 } });
    expect(statuses).toEqual(['Downloading update...', 'Downloading update... 0%', 'Downloading update... 100%']);
  });

  it('stays on the plain label when the size is unknown', () => {
    const statuses: string[] = [];
    const report = downloadProgressReporter((s) => statuses.push(s));
    report({ event: 'Started', data: {} });
    report({ event: 'Progress', data: { chunkLength: 500 } });
    expect(statuses).toEqual(['Downloading update...']);
  });
});

describe('checkForUpdates mandatory flag', () => {
  const withMinimum = (currentVersion: string, minimumVersion: unknown) =>
    makeUpdate({ currentVersion, rawJson: { minimumVersion } });

  it('is false when the manifest declares no minimumVersion', async () => {
    mockCheck.mockResolvedValue(makeUpdate({ rawJson: {} }));
    expect((await checkForUpdates()).mandatory).toBe(false);
  });

  it('is true when the installed version is below the minimum', async () => {
    mockCheck.mockResolvedValue(withMinimum('0.0.39', '0.0.40'));
    expect((await checkForUpdates()).mandatory).toBe(true);
  });

  it('is false when the installed version equals the minimum', async () => {
    mockCheck.mockResolvedValue(withMinimum('0.0.40', '0.0.40'));
    expect((await checkForUpdates()).mandatory).toBe(false);
  });

  it('is false when the installed version is above the minimum', async () => {
    mockCheck.mockResolvedValue(withMinimum('0.0.41', '0.0.40'));
    expect((await checkForUpdates()).mandatory).toBe(false);
  });

  it('treats a pre-release as below the matching stable minimum', async () => {
    mockCheck.mockResolvedValue(withMinimum('0.0.40-rc.1', '0.0.40'));
    expect((await checkForUpdates()).mandatory).toBe(true);
  });

  it('compares across minor and major boundaries, not lexically', async () => {
    mockCheck.mockResolvedValue(withMinimum('0.0.9', '0.0.10'));
    expect((await checkForUpdates()).mandatory).toBe(true);
  });

  // A malformed manifest must never lock a user out of the app.
  it.each([undefined, '', 42, null, {}])('is false for a non-semver minimumVersion: %s', async (minimum) => {
    mockCheck.mockResolvedValue(withMinimum('0.0.39', minimum));
    expect((await checkForUpdates()).mandatory).toBe(false);
  });
});

describe('getCurrentVersion', () => {
  it('returns the version from the Tauri app API', async () => {
    const version = await getCurrentVersion();
    expect(version).toBe('0.0.39');
  });
});
