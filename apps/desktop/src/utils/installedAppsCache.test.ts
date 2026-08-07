import { describe, it, expect, beforeEach, vi } from 'vitest';

const listApplications = vi.fn();
vi.mock('../lib/mero-client', () => ({
  apiClient: { node: { listApplications: () => listApplications() } },
}));

import { listInstalledApps, invalidateInstalledApps } from './installedAppsCache';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstalledApps();
  listApplications.mockResolvedValue({ data: [{ id: 'app-1' }] });
});

describe('listInstalledApps', () => {
  it('serves repeat reads from the cache', async () => {
    const first = await listInstalledApps();
    const second = await listInstalledApps();

    expect(second).toBe(first);
    expect(listApplications).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent reads into one round trip', async () => {
    const [a, b, c] = await Promise.all([
      listInstalledApps(),
      listInstalledApps(),
      listInstalledApps(),
    ]);

    expect(listApplications).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('refetches once the entry is older than the TTL', async () => {
    await listInstalledApps();
    await listInstalledApps(0);

    expect(listApplications).toHaveBeenCalledTimes(2);
  });

  it('refetches after an install or uninstall invalidates it', async () => {
    await listInstalledApps();
    invalidateInstalledApps();
    await listInstalledApps();

    expect(listApplications).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure, so a 401 does not outlive the stale token', async () => {
    listApplications.mockResolvedValueOnce({ error: { message: 'Unauthorized', code: '401' } });

    expect((await listInstalledApps()).error?.code).toBe('401');
    expect((await listInstalledApps()).data).toEqual([{ id: 'app-1' }]);
    expect(listApplications).toHaveBeenCalledTimes(2);
  });

  it('freezes the list so one caller cannot reorder it for the other five', async () => {
    listApplications.mockResolvedValue({ data: [{ id: 'app-2' }, { id: 'app-1' }] });
    const { data } = await listInstalledApps();

    expect(() => data!.sort((a, b) => a.id.localeCompare(b.id))).toThrow(TypeError);
  });

  it('drops a read that an install invalidated mid-flight', async () => {
    let finish!: (response: unknown) => void;
    listApplications.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const preInstall = listInstalledApps();

    invalidateInstalledApps();
    finish({ data: [{ id: 'app-1' }] });
    await preInstall;

    listApplications.mockResolvedValue({ data: [{ id: 'app-1' }, { id: 'app-2' }] });
    expect((await listInstalledApps()).data).toHaveLength(2);
  });

  it('clears the in-flight slot when the request rejects', async () => {
    listApplications.mockRejectedValueOnce(new Error('node down'));

    await expect(listInstalledApps()).rejects.toThrow('node down');
    await expect(listInstalledApps()).resolves.toEqual({ data: [{ id: 'app-1' }] });
  });
});
