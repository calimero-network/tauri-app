import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAppVersions, fetchBundleDisplay, nodeBuildLabel } from './registry';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchBundleDisplay', () => {
  it('returns only name/icon/description, dropping links and everything else', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        package: 'com.calimero.chat',
        appVersion: '3.1.1',
        metadata: {
          name: 'Mero Chat',
          icon: 'data:image/png;base64,QUJD',
          description: 'Chat app',
          links: { frontend: 'https://evil.example' },
        },
      }),
    }) as unknown as typeof fetch;

    const display = await fetchBundleDisplay('https://registry.example', 'com.calimero.chat', '3.1.1');

    expect(display).toEqual({ name: 'Mero Chat', icon: 'data:image/png;base64,QUJD', description: 'Chat app' });
  });

  it('drops an icon that is not a data:image/ URI', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ metadata: { name: 'Mero Chat', icon: 'https://evil.example/x.png' } }),
    }) as unknown as typeof fetch;

    const display = await fetchBundleDisplay('https://registry.example', 'com.calimero.chat', '3.1.1');

    expect(display).toEqual({ name: 'Mero Chat' });
  });

  it('hands the caller\'s signal to fetch, so a timed-out lookup is cancelled', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ metadata: { name: 'Mero Chat' } }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();

    await fetchBundleDisplay('https://registry.example', 'com.calimero.chat', '3.1.1', controller.signal);

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('returns null on a non-OK response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;

    expect(await fetchBundleDisplay('https://registry.example', 'com.calimero.chat', '3.1.1')).toBeNull();
  });

  it('returns null and never throws when the fetch itself fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    await expect(
      fetchBundleDisplay('https://registry.example', 'com.calimero.chat', '3.1.1'),
    ).resolves.toBeNull();
  });

  it('returns null for a package id that fails the same guard as fetchAppManifest', async () => {
    global.fetch = vi.fn();
    expect(await fetchBundleDisplay('https://registry.example', '../../etc', '3.1.1')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('nodeBuildLabel', () => {
  it('names the release when the bundle stamps one', () => {
    expect(nodeBuildLabel({ sdkSource: 'git', sdkVersion: '0.11.0-rc.54', sdkRev: '90ea153bf0e6c647e47be1ad2b2142ecb571cc63' })).toBe(
      '0.11.0-rc.54',
    );
  });

  it('falls back to a short commit for a branch/rev build', () => {
    expect(nodeBuildLabel({ sdkSource: 'git', sdkRev: '90ea153bf0e6c647e47be1ad2b2142ecb571cc63' })).toBe('90ea153');
  });

  it('is null for a bundle that does not say, never a placeholder', () => {
    expect(nodeBuildLabel(undefined)).toBeNull();
    expect(nodeBuildLabel(null)).toBeNull();
    expect(nodeBuildLabel({ sdkSource: 'path' })).toBeNull();
    expect(nodeBuildLabel({ sdkVersion: '  ' })).toBeNull();
  });
});

describe('fetchAppVersions', () => {
  it('carries each version its own node build, and ignores minRuntimeVersion', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { package: 'com.calimero.mero-ar', appVersion: '0.0.11', minRuntimeVersion: '0.11.0-rc.42', buildInfo: { sdkVersion: '0.11.0-rc.42' } },
        { package: 'com.calimero.mero-ar', appVersion: '0.0.12', minRuntimeVersion: '0.11.0-rc.55', buildInfo: { sdkVersion: '0.11.0-rc.55' } },
        // Published before cargo-mero stamped buildInfo: the floor is not a build.
        { package: 'com.calimero.mero-ar', appVersion: '0.0.7', minRuntimeVersion: '0.11.0-rc.32' },
      ],
    }) as unknown as typeof fetch;

    const versions = await fetchAppVersions('https://registry.example', 'com.calimero.mero-ar');

    expect(versions.map((v) => [v.semver, v.nodeBuild])).toEqual([
      ['0.0.12', '0.11.0-rc.55'],
      ['0.0.11', '0.11.0-rc.42'],
      ['0.0.7', null],
    ]);
  });
});
