import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const getByLabel = vi.fn();
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: (...a: unknown[]) => getByLabel(...a) },
}));

// Keep the broker's own imports (Tauri event API, mero-client) inert — this
// suite only needs the sentinel constant it exports.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('../lib/mero-client', () => ({ apiClient: {} }));

let developerMode = false;
vi.mock('./settings', () => ({
  getSettings: () => ({ nodeUrl: 'http://localhost:2528', developerMode }),
}));

const REAL_REFRESH_TOKEN = 'the-real-single-use-refresh-token';
let accessToken: string | null;
let refreshToken: string | null;
vi.mock('../lib/token-storage', () => ({
  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,
  getTokenExpiresAt: () => 1_700_000_000_000,
}));

import { openAppFrontend, normalizeNodeUrl } from './appUtils';
import { BROKERED_REFRESH_TOKEN } from '../lib/token-broker';

/** Args of the `create_app_window` invoke (may not be the first call — the app
 * launcher is attempted first). */
function createWindowArgs(): { url: string } {
  const call = invoke.mock.calls.find((c) => c[0] === 'create_app_window');
  expect(call, 'create_app_window was not invoked').toBeTruthy();
  return (call as [string, { url: string }])[1];
}

/** The hash params of the URL `create_app_window` was invoked with. */
function openedHash(): URLSearchParams {
  return new URLSearchParams(new URL(createWindowArgs().url).hash.slice(1));
}

function openedUrl(): string {
  return createWindowArgs().url;
}

beforeEach(() => {
  vi.clearAllMocks();
  developerMode = false;
  accessToken = 'the-access-token';
  refreshToken = REAL_REFRESH_TOKEN;
  getByLabel.mockResolvedValue(null);
  // `openAppFrontend` prefers the per-app launcher (`open_app_launcher`) and
  // only falls back to the in-process window when it's unavailable. These tests
  // cover that fallback window path (the token-handoff safety), so make the
  // launcher reject — as it does off-macOS or when no launcher can be built.
  invoke.mockImplementation((cmd: string) =>
    cmd === 'open_app_launcher'
      ? Promise.reject(new Error('no launcher in test env'))
      : Promise.resolve(undefined),
  );
});

describe('openAppFrontend token handoff', () => {
  // The regression this whole change exists to prevent.
  //
  // Refresh tokens are single-use (calimero-network/core#3083). Every app
  // webview is its own origin with its own localStorage and its own MeroJs, so
  // shipping the real refresh token in the URL hash gave N independent holders
  // one single-use token: the first to rotate consumes it, the next one presents
  // a consumed token, and the node revokes the family — logging out the desktop
  // and every app at once.
  it('never puts the real refresh token in the app window URL', async () => {
    await openAppFrontend('https://app.example.com/', 'Example');

    expect(openedUrl()).not.toContain(REAL_REFRESH_TOKEN);
    expect(openedHash().get('refresh_token')).not.toBe(REAL_REFRESH_TOKEN);
  });

  it('hands the app the access token plus the brokered sentinel', async () => {
    await openAppFrontend('https://app.example.com/', 'Example');

    const hash = openedHash();
    expect(hash.get('access_token')).toBe('the-access-token');
    expect(hash.get('refresh_token')).toBe(BROKERED_REFRESH_TOKEN);
    expect(hash.get('node_url')).toBe('http://localhost:2528');
  });

  // Why a sentinel and not simply omitting `refresh_token`.
  //
  // Two independent things in the app-side stack turn an absent/empty refresh
  // slot into a worse bug than the one this change fixes:
  //
  //   * mero-js `parseAuthCallback()` does `refresh_token: params.get('refresh_token') ?? ''`,
  //     and mero-react's token store writes `token.refresh_token` UNCONDITIONALLY.
  //     An access-token-only hash therefore makes an app overwrite its stored
  //     refresh token with an empty string (until mero-react#45 ships).
  //   * mero-js `performTokenRefresh()` throws "No refresh token available" and
  //     never calls /auth/refresh at all when the slot is empty — so the app
  //     could not be brokered either; it would just hard-fail on the first 401.
  //
  // Keeping the slot populated with an inert sentinel sidesteps both, and means
  // this change needs no coordinated app/mero-react release.
  it('keeps the refresh_token slot populated, so an app can never blank its own', async () => {
    await openAppFrontend('https://app.example.com/', 'Example');

    const slot = openedHash().get('refresh_token');
    expect(slot).toBeTruthy();
    expect(slot).not.toBe('');
    expect(slot).toBe(BROKERED_REFRESH_TOKEN);
  });

  it('sends no tokens at all when the desktop is not logged in', async () => {
    accessToken = null;
    refreshToken = null;

    await openAppFrontend('https://app.example.com/', 'Example');

    const hash = openedHash();
    expect(hash.has('access_token')).toBe(false);
    expect(hash.has('refresh_token')).toBe(false);
  });

  it('forwards app context and dev mode without touching the refresh token', async () => {
    developerMode = true;
    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
      contextId: 'ctx-1',
      executorPublicKey: 'pk-1',
    });

    const hash = openedHash();
    expect(hash.get('app-id')).toBe('app-1');
    expect(hash.get('context_id')).toBe('ctx-1');
    expect(hash.get('executor_public_key')).toBe('pk-1');
    expect(hash.get('dev_mode')).toBe('1');
    expect(openedUrl()).not.toContain(REAL_REFRESH_TOKEN);
  });
});

describe('openAppFrontend re-opening an existing window', () => {
  it('focuses it and signals a re-read, carrying no credentials', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const existing = {
      isMinimized: vi.fn().mockResolvedValue(true),
      unminimize: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
      emit,
    };
    getByLabel.mockResolvedValue(existing);

    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
    });

    expect(existing.unminimize).toHaveBeenCalled();
    expect(existing.setFocus).toHaveBeenCalled();
    // No new window, and no token re-injection over the app's live state.
    expect(invoke).not.toHaveBeenCalledWith('create_app_window', expect.anything());

    const [eventName, payload] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(eventName).toBe('calimero:auth-refresh');
    expect(JSON.stringify(payload)).not.toContain(REAL_REFRESH_TOKEN);
    expect(JSON.stringify(payload)).not.toContain('the-access-token');
  });
});

describe('openAppFrontend targeting a second node', () => {
  /** Full args of the `create_app_window` invoke. */
  function windowArgs(): Record<string, unknown> {
    const call = invoke.mock.calls.find((c) => c[0] === 'create_app_window');
    expect(call, 'create_app_window was not invoked').toBeTruthy();
    return (call as [string, Record<string, unknown>])[1];
  }

  it('keeps the historical label and the launcher path for the active node', async () => {
    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
      targetNodeUrl: 'http://localhost:2528',
    });

    // Byte-identical to a call with no targetNodeUrl at all, or every window
    // already open under the old label would be orphaned.
    expect(windowArgs().windowLabel).toBe('app-app-1');
    expect(windowArgs().isolationKey).toBeNull();
  });

  it('gives a cross-node window its own label, node URL and isolation key', async () => {
    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
      targetNodeUrl: 'http://localhost:2529',
    });

    const args = windowArgs();
    expect(args.windowLabel).toBe('app-app-1-nhttp-localhost-2529');
    expect(args.nodeUrl).toBe('http://localhost:2529');
    expect(args.isolationKey).toBe('app-1@http://localhost:2529');
    expect(String(args.title)).toContain('2529');
  });

  it('sends no credentials to a node our session does not belong to', async () => {
    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
      targetNodeUrl: 'http://localhost:2529',
    });

    const hash = openedHash();
    expect(hash.get('node_url')).toBe('http://localhost:2529');
    expect(hash.get('access_token')).toBeNull();
    expect(hash.get('refresh_token')).toBeNull();
    expect(openedUrl()).not.toContain(REAL_REFRESH_TOKEN);
    expect(openedUrl()).not.toContain('the-access-token');
  });

  it('gives two default-port hosts different labels', async () => {
    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
      targetNodeUrl: 'https://alpha.example.com',
    });
    const a = String(windowArgs().windowLabel);
    invoke.mockClear();
    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
      targetNodeUrl: 'https://beta.example.com',
    });
    const b = String(windowArgs().windowLabel);
    // URL.port is '' for https default 443; keying on it alone collided here.
    expect(a).not.toBe(b);
  });

  it('keeps the label within the 64 character limit for a long application id', async () => {
    const longId = 'a'.repeat(80);
    await openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: longId,
      targetNodeUrl: 'http://localhost:2529',
    });

    const label = String(windowArgs().windowLabel);
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.endsWith('-nhttp-localhost-2529')).toBe(true);
  });
});

describe('normalizeNodeUrl', () => {
  it('treats cosmetic differences as the same node', () => {
    const base = normalizeNodeUrl('http://localhost:2528');
    expect(normalizeNodeUrl('http://localhost:2528/')).toBe(base);
    expect(normalizeNodeUrl('http://localhost:2528//')).toBe(base);
    expect(normalizeNodeUrl('http://LOCALHOST:2528')).toBe(base);
    expect(normalizeNodeUrl('http://localhost')).toBe(normalizeNodeUrl('http://localhost:80'));
    expect(normalizeNodeUrl('https://n.example.com')).toBe(
      normalizeNodeUrl('https://n.example.com:443'),
    );
  });

  it('keeps genuinely different targets apart', () => {
    expect(normalizeNodeUrl('http://localhost:2528')).not.toBe(
      normalizeNodeUrl('http://localhost:2529'),
    );
    // Separate web origins, so separate localStorage and separate sessions:
    // collapsing these would hand one origin's window another origin's state.
    expect(normalizeNodeUrl('http://localhost:2528')).not.toBe(
      normalizeNodeUrl('http://127.0.0.1:2528'),
    );
  });
});

describe('cross-node window labels', () => {
  function labelFor(target: string) {
    invoke.mockClear();
    return openAppFrontend('https://app.example.com/', 'Example', undefined, {
      applicationId: 'app-1',
      targetNodeUrl: target,
    }).then(() => {
      const call = invoke.mock.calls.find((c) => c[0] === 'create_app_window');
      return String((call as [string, { windowLabel: string }])[1].windowLabel);
    });
  }

  it('separates targets that differ only by scheme', async () => {
    // Both omit an explicit port, so hostname alone collided and the second
    // target focused the first target's window instead of isolating.
    const a = await labelFor('http://example.com');
    const b = await labelFor('https://example.com');
    expect(a).not.toBe(b);
  });

  it('keeps every label inside Tauri’s 64 character limit', async () => {
    const long = await labelFor('https://a-very-long-node-hostname.example.internal:8443');
    expect(long.length).toBeLessThanOrEqual(64);
  });
});
