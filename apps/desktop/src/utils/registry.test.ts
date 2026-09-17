import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchBundleDisplay } from './registry';

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
