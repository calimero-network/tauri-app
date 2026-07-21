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

import { openAppFrontend } from './appUtils';
import { BROKERED_REFRESH_TOKEN } from '../lib/token-broker';

/** The hash params of the URL `create_app_window` was invoked with. */
function openedHash(): URLSearchParams {
  expect(invoke).toHaveBeenCalledWith('create_app_window', expect.anything());
  const [, args] = invoke.mock.calls[0] as [string, { url: string }];
  return new URLSearchParams(new URL(args.url).hash.slice(1));
}

function openedUrl(): string {
  const [, args] = invoke.mock.calls[0] as [string, { url: string }];
  return args.url;
}

beforeEach(() => {
  vi.clearAllMocks();
  developerMode = false;
  accessToken = 'the-access-token';
  refreshToken = REAL_REFRESH_TOKEN;
  getByLabel.mockResolvedValue(null);
  invoke.mockResolvedValue(undefined);
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
