import { describe, it, expect, beforeEach, vi } from 'vitest';

const listApplications = vi.fn();
vi.mock('../lib/mero-client', () => ({
  apiClient: { node: { listApplications: () => listApplications() } },
}));

let nodeUrl = 'http://localhost:2528';
let registries = ['https://registry-a.example', 'https://registry-b.example'];
vi.mock('./settings', () => ({ getSettings: () => ({ nodeUrl, registries }) }));

const fetchBundleDisplay = vi.fn();
vi.mock('./registry', () => ({ fetchBundleDisplay: (...args: unknown[]) => fetchBundleDisplay(...args) }));

import { listInstalledApps, invalidateInstalledApps, needsDisplayBackfill } from './installedAppsCache';

beforeEach(() => {
  vi.clearAllMocks();
  nodeUrl = 'http://localhost:2528';
  registries = ['https://registry-a.example', 'https://registry-b.example'];
  invalidateInstalledApps();
  fetchBundleDisplay.mockResolvedValue(null);
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

  it('never serves one node\'s list after the app is pointed at another', async () => {
    expect((await listInstalledApps()).data).toEqual([{ id: 'app-1' }]);

    nodeUrl = 'http://localhost:3528';
    listApplications.mockResolvedValue({ data: [{ id: 'app-2' }] });

    expect((await listInstalledApps()).data).toEqual([{ id: 'app-2' }]);
    expect(listApplications).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight slot when the request rejects', async () => {
    listApplications.mockRejectedValueOnce(new Error('node down'));

    await expect(listInstalledApps()).rejects.toThrow('node down');
    await expect(listInstalledApps()).resolves.toEqual({ data: [{ id: 'app-1' }] });
  });
});

describe('listInstalledApps display backfill', () => {
  const blobShareRow = (pkg: string, version: string) => ({
    id: 'app-1',
    package: pkg,
    version,
    metadata: [],
    blob: { bytecode: 'e348' },
    source: 'calimero://pending-blob-share',
  });

  it('borrows name/icon from the first registry that answers', async () => {
    const row = blobShareRow('com.calimero.chat', '1.0.0');
    listApplications.mockResolvedValue({ data: [row] });
    fetchBundleDisplay.mockResolvedValueOnce({ name: 'Mero Chat' });

    const { data } = await listInstalledApps();

    expect(data![0].metadata).toEqual({ name: 'Mero Chat' });
    expect(fetchBundleDisplay).toHaveBeenCalledWith(
      'https://registry-a.example',
      'com.calimero.chat',
      '1.0.0',
      expect.any(AbortSignal),
    );
  });

  it('falls through to the next registry when the first has nothing', async () => {
    const row = blobShareRow('com.calimero.drive', '2.0.0');
    listApplications.mockResolvedValue({ data: [row] });
    fetchBundleDisplay.mockResolvedValueOnce(null).mockResolvedValueOnce({ name: 'Mero Drive' });

    const { data } = await listInstalledApps();

    expect(data![0].metadata).toEqual({ name: 'Mero Drive' });
    expect(fetchBundleDisplay).toHaveBeenNthCalledWith(
      1, 'https://registry-a.example', 'com.calimero.drive', '2.0.0', expect.any(AbortSignal),
    );
    expect(fetchBundleDisplay).toHaveBeenNthCalledWith(
      2, 'https://registry-b.example', 'com.calimero.drive', '2.0.0', expect.any(AbortSignal),
    );
  });

  it('leaves the row untouched when every registry has nothing', async () => {
    const row = blobShareRow('com.calimero.nothing', '3.0.0');
    listApplications.mockResolvedValue({ data: [row] });
    fetchBundleDisplay.mockResolvedValue(null);

    const { data } = await listInstalledApps();

    expect(data![0].metadata).toEqual([]);
  });

  it('never calls the registry for a row that already has a name', async () => {
    const row = { ...blobShareRow('com.calimero.named', '4.0.0'), metadata: { name: 'Already Named' } };
    listApplications.mockResolvedValue({ data: [row] });

    const { data } = await listInstalledApps();

    expect(data![0].metadata).toEqual({ name: 'Already Named' });
    expect(fetchBundleDisplay).not.toHaveBeenCalled();
  });

  it('memoizes a successful lookup so the 30s poll does not refetch it', async () => {
    const row = blobShareRow('com.calimero.memo', '5.0.0');
    listApplications.mockResolvedValue({ data: [row] });
    fetchBundleDisplay.mockResolvedValueOnce({ name: 'Memo App' });

    await listInstalledApps();
    invalidateInstalledApps();
    const { data } = await listInstalledApps();

    expect(data![0].metadata).toEqual({ name: 'Memo App' });
    expect(fetchBundleDisplay).toHaveBeenCalledTimes(1);
  });

  it('remembers a miss for the list TTL, then asks the registries again', async () => {
    vi.useFakeTimers();
    try {
      listApplications.mockResolvedValue({ data: [blobShareRow('com.calimero.unlisted', '7.0.0')] });

      await listInstalledApps();
      invalidateInstalledApps();
      await listInstalledApps();
      expect(fetchBundleDisplay).toHaveBeenCalledTimes(registries.length);

      vi.advanceTimersByTime(5 * 60 * 1000);
      invalidateInstalledApps();
      await listInstalledApps();
      expect(fetchBundleDisplay).toHaveBeenCalledTimes(registries.length * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a hung registry lookup at 4s rather than leaving it running', async () => {
    vi.useFakeTimers();
    try {
      const row = blobShareRow('com.calimero.slow', '6.0.0');
      listApplications.mockResolvedValue({ data: [row] });
      let cancelled = false;
      fetchBundleDisplay
        .mockImplementationOnce(
          (...args: unknown[]) =>
            new Promise((resolve) =>
              (args[3] as AbortSignal).addEventListener('abort', () => {
                cancelled = true;
                resolve(null);
              }),
            ),
        )
        .mockResolvedValueOnce({ name: 'Slow App' });

      const promise = listInstalledApps();
      await vi.advanceTimersByTimeAsync(4000);
      const { data } = await promise;

      expect(cancelled).toBe(true);
      expect(data![0].metadata).toEqual({ name: 'Slow App' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('needsDisplayBackfill', () => {
  // The row core seeds for a follower whose bytecode arrived by blob share
  // instead of a registry install: package/version set, metadata empty.
  const BLOB_SHARE_ROW = {
    id: '3f550253',
    package: 'com.calimero.chat',
    version: '3.1.1',
    blob: { bytecode: 'e348' },
    metadata: [],
    source: 'calimero://pending-blob-share',
  };

  it('is true for a row with package/version but no name in its metadata', () => {
    expect(needsDisplayBackfill(BLOB_SHARE_ROW)).toBe(true);
  });

  it('is false once metadata already carries a name', () => {
    expect(needsDisplayBackfill({ ...BLOB_SHARE_ROW, metadata: { name: 'Mero Chat' } })).toBe(false);
  });

  it('is false without a package', () => {
    expect(needsDisplayBackfill({ ...BLOB_SHARE_ROW, package: undefined })).toBe(false);
  });

  it('is false without a version', () => {
    expect(needsDisplayBackfill({ ...BLOB_SHARE_ROW, version: undefined })).toBe(false);
  });
});
