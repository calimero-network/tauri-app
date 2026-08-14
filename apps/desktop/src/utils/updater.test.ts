import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — use vi.hoisted() so the mock vars are available when
// the factory runs.
const {
  mockDownloadAndInstall,
  mockRelaunch,
  mockCheck,
  mockGetVersion,
  mockStopMerod,
  mockDownloadAndReplace,
} = vi.hoisted(() => ({
  mockDownloadAndInstall: vi.fn().mockResolvedValue(undefined),
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

// A fake v2 Update handle. downloadAndInstall is delegated to the shared mock
// so tests can assert on / reorder it.
const makeUpdate = (over: Record<string, unknown> = {}) => ({
  version: '0.0.40',
  currentVersion: '0.0.39',
  date: '2026-05-22',
  body: 'bug fixes',
  rawJson: {},
  downloadAndInstall: mockDownloadAndInstall,
  ...over,
});

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mockCheck }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mockRelaunch }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mockGetVersion }));
vi.mock('./merod', () => ({
  stopMerod: mockStopMerod,
  downloadAndReplaceMerod: mockDownloadAndReplace,
}));

// Fake Tauri environment — vitest runs in node where `window` doesn't exist,
// so we define it on globalThis so that isTauri() returns true. Tauri v2
// injects __TAURI_INTERNALS__ regardless of withGlobalTauri.
(globalThis as any).window = { __TAURI_INTERNALS__: {} };

import { installUpdate, checkForUpdates, getCurrentVersion } from './updater';

beforeEach(() => {
  vi.clearAllMocks();
  mockDownloadAndInstall.mockResolvedValue(undefined);
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
  it('runs the full sequence in order: stop → download merod → install app → relaunch', async () => {
    const callOrder: string[] = [];
    mockStopMerod.mockImplementation(async () => { callOrder.push('stopMerod'); });
    mockDownloadAndReplace.mockImplementation(async () => {
      callOrder.push('downloadAndReplace');
      return { replaced: true, expected_version: '0.10.1-rc.43', current_version: 'merod 0.10.1-rc.43', message: '' };
    });
    mockDownloadAndInstall.mockImplementation(async () => { callOrder.push('downloadAndInstall'); });
    mockRelaunch.mockImplementation(async () => { callOrder.push('relaunch'); });

    await installUpdate();

    expect(callOrder).toEqual(['stopMerod', 'downloadAndReplace', 'downloadAndInstall', 'relaunch']);
  });

  it('stops only the app\'s own tracked node(s), never every merod on the machine', async () => {
    // Regression: installUpdate used to force-kill every merod process on the
    // machine. It must only stop nodes this app is tracking, which stopMerod()
    // does. The machine-wide command it used to call no longer exists at all.
    await installUpdate();

    expect(mockStopMerod).toHaveBeenCalledOnce();
  });

  it('calls onStatus with each step label', async () => {
    const statuses: string[] = [];
    await installUpdate((s) => statuses.push(s));

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
    expect(mockDownloadAndInstall).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('throws and does NOT relaunch when Tauri returns a serialized error object with version mismatch', async () => {
    // Tauri invoke() rejects with a plain object {message, code}, not a JS Error instance
    mockDownloadAndReplace.mockRejectedValue({
      message: "Version mismatch after replace: expected '0.10.1-rc.43', binary reports 'merod 0.10.1-rc.42'",
      code: 'InternalError',
    });
    await expect(installUpdate()).rejects.toMatchObject({ message: expect.stringContaining('Version mismatch') });
    expect(mockDownloadAndInstall).not.toHaveBeenCalled();
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

  it('throws and does NOT relaunch when downloadAndInstall fails', async () => {
    mockDownloadAndInstall.mockRejectedValue(new Error('no update package'));
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
