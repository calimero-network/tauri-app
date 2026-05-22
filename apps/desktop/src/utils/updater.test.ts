import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — use vi.hoisted() so the mock vars are available when
// the factory runs.
const {
  mockTauriInstallUpdate,
  mockRelaunch,
  mockCheckUpdate,
  mockGetVersion,
  mockStopMerod,
  mockKillAll,
  mockDownloadAndReplace,
} = vi.hoisted(() => ({
  mockTauriInstallUpdate: vi.fn().mockResolvedValue(undefined),
  mockRelaunch: vi.fn().mockResolvedValue(undefined),
  mockCheckUpdate: vi.fn().mockResolvedValue({ shouldUpdate: false, manifest: null }),
  mockGetVersion: vi.fn().mockResolvedValue('0.0.39'),
  mockStopMerod: vi.fn().mockResolvedValue('stopped'),
  mockKillAll: vi.fn().mockResolvedValue('killed'),
  mockDownloadAndReplace: vi.fn().mockResolvedValue({
    replaced: true,
    expected_version: '0.10.1-rc.42',
    current_version: 'merod 0.10.1-rc.42',
    message: 'merod updated',
  }),
}));

vi.mock('@tauri-apps/api/updater', () => ({
  installUpdate: mockTauriInstallUpdate,
  checkUpdate: mockCheckUpdate,
}));
vi.mock('@tauri-apps/api/process', () => ({ relaunch: mockRelaunch }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mockGetVersion }));
vi.mock('./merod', () => ({
  stopMerod: mockStopMerod,
  killAllMerodProcesses: mockKillAll,
  downloadAndReplaceMerod: mockDownloadAndReplace,
}));

// Fake Tauri environment — vitest runs in node where `window` doesn't exist,
// so we define it on globalThis so that isTauri() returns true.
(globalThis as any).window = { __TAURI__: {} };

import { installUpdate, checkForUpdates, getCurrentVersion } from './updater';

beforeEach(() => {
  vi.clearAllMocks();
  mockTauriInstallUpdate.mockResolvedValue(undefined);
  mockRelaunch.mockResolvedValue(undefined);
  mockCheckUpdate.mockResolvedValue({ shouldUpdate: false, manifest: null });
  mockGetVersion.mockResolvedValue('0.0.39');
  mockStopMerod.mockResolvedValue('stopped');
  mockKillAll.mockResolvedValue('killed');
  mockDownloadAndReplace.mockResolvedValue({
    replaced: true,
    expected_version: '0.10.1-rc.42',
    current_version: 'merod 0.10.1-rc.42',
    message: 'merod updated',
  });
});

describe('installUpdate', () => {
  it('runs the full sequence in order: stop → download merod → install app → relaunch', async () => {
    const callOrder: string[] = [];
    mockStopMerod.mockImplementation(async () => { callOrder.push('stopMerod'); });
    mockKillAll.mockImplementation(async () => { callOrder.push('killAll'); });
    mockDownloadAndReplace.mockImplementation(async () => {
      callOrder.push('downloadAndReplace');
      return { replaced: true, expected_version: '0.10.1-rc.42', current_version: 'merod 0.10.1-rc.42', message: '' };
    });
    mockTauriInstallUpdate.mockImplementation(async () => { callOrder.push('tauriInstallUpdate'); });
    mockRelaunch.mockImplementation(async () => { callOrder.push('relaunch'); });

    await installUpdate();

    expect(callOrder).toEqual(['stopMerod', 'killAll', 'downloadAndReplace', 'tauriInstallUpdate', 'relaunch']);
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

  it('proceeds even when killAllMerodProcesses throws', async () => {
    mockKillAll.mockRejectedValue(new Error('kill failed'));
    await expect(installUpdate()).resolves.toBeUndefined();
    expect(mockDownloadAndReplace).toHaveBeenCalledOnce();
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });

  it('throws and does NOT relaunch when merod download fails (version mismatch)', async () => {
    mockDownloadAndReplace.mockRejectedValue(
      new Error("Version mismatch after replace: expected '0.10.1-rc.42', binary reports 'merod 0.10.1-rc.41'"),
    );
    await expect(installUpdate()).rejects.toThrow('Version mismatch');
    expect(mockTauriInstallUpdate).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('throws and does NOT relaunch when Tauri returns a serialized error object with version mismatch', async () => {
    // Tauri invoke() rejects with a plain object {message, code}, not a JS Error instance
    mockDownloadAndReplace.mockRejectedValue({
      message: "Version mismatch after replace: expected '0.10.1-rc.42', binary reports 'merod 0.10.1-rc.41'",
      code: 'InternalError',
    });
    await expect(installUpdate()).rejects.toMatchObject({ message: expect.stringContaining('Version mismatch') });
    expect(mockTauriInstallUpdate).not.toHaveBeenCalled();
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

  it('throws and does NOT relaunch when tauriInstallUpdate fails', async () => {
    mockTauriInstallUpdate.mockRejectedValue(new Error('no update package'));
    await expect(installUpdate()).rejects.toThrow('no update package');
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('still relaunches when binary was already at the correct version (replaced=false)', async () => {
    mockDownloadAndReplace.mockResolvedValue({
      replaced: false,
      expected_version: '0.10.1-rc.42',
      current_version: 'merod 0.10.1-rc.42',
      message: 'Binary is already at the expected version',
    });
    const statuses: string[] = [];
    await installUpdate((s) => statuses.push(s));
    expect(mockRelaunch).toHaveBeenCalledOnce();
  });
});

describe('checkForUpdates', () => {
  it('returns available=false when shouldUpdate is false', async () => {
    const result = await checkForUpdates();
    expect(result.available).toBe(false);
  });

  it('returns available=true with manifest when update exists', async () => {
    mockCheckUpdate.mockResolvedValue({
      shouldUpdate: true,
      manifest: { version: '0.0.40', date: '2026-05-22', body: 'bug fixes' },
    });
    const result = await checkForUpdates();
    expect(result.available).toBe(true);
    expect(result.info?.version).toBe('0.0.40');
  });
});

describe('getCurrentVersion', () => {
  it('returns the version from the Tauri app API', async () => {
    const version = await getCurrentVersion();
    expect(version).toBe('0.0.39');
  });
});
