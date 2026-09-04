import { describe, it, expect, beforeEach } from 'vitest';

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

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
  globalThis.sessionStorage = fakeStorage();
});

import {
  getSettings,
  saveSettings,
  clearAllAppData,
  DEFAULT_EMBEDDED_NODE_PORT,
  DEFAULT_EMBEDDED_SWARM_PORT,
} from './settings';

describe('embedded node ports', () => {
  it('round-trips the swarm port so autostart cannot revert it', () => {
    // The bug: only the server port was persisted, so App.tsx's autostart fell back
    // to a hardcoded 2428 and start_merod rewrote config.toml with it — silently
    // undoing a node the user had created on another swarm port.
    saveSettings({
      nodeUrl: 'http://localhost:2529',
      embeddedNodePort: 2529,
      embeddedNodeSwarmPort: 2429,
    });

    const settings = getSettings();
    expect(settings.embeddedNodePort).toBe(2529);
    expect(settings.embeddedNodeSwarmPort).toBe(2429);
  });

  it('leaves both ports undefined when unset, so callers apply the shared defaults', () => {
    saveSettings({ nodeUrl: 'http://localhost:2528' });

    const settings = getSettings();
    expect(settings.embeddedNodePort).toBeUndefined();
    expect(settings.embeddedNodeSwarmPort).toBeUndefined();
    expect(settings.embeddedNodePort ?? DEFAULT_EMBEDDED_NODE_PORT).toBe(2528);
    expect(settings.embeddedNodeSwarmPort ?? DEFAULT_EMBEDDED_SWARM_PORT).toBe(2428);
  });
});

describe('getSettings memoisation', () => {
  it('reuses the parsed object until the stored value changes', () => {
    saveSettings({ nodeUrl: 'http://localhost:2528' });

    const first = getSettings();
    expect(getSettings()).toBe(first);

    saveSettings({ nodeUrl: 'http://localhost:2529' });

    const second = getSettings();
    expect(second).not.toBe(first);
    expect(second.nodeUrl).toBe('http://localhost:2529');
  });

  it('picks up a write that did not go through saveSettings', () => {
    saveSettings({ nodeUrl: 'http://localhost:2528' });
    getSettings();

    localStorage.setItem(
      'calimero-desktop-settings',
      JSON.stringify({ nodeUrl: 'http://localhost:2530' })
    );

    expect(getSettings().nodeUrl).toBe('http://localhost:2530');
  });

  it('hands back a frozen object so a caller cannot poison the cache', () => {
    saveSettings({ nodeUrl: 'http://localhost:2528' });

    expect(() => {
      (getSettings() as { nodeUrl: string }).nodeUrl = 'http://evil';
    }).toThrow();
    expect(getSettings().nodeUrl).toBe('http://localhost:2528');
  });
});

describe('buildSettings defaults', () => {
  it('falls back to the default node URL when stored as empty', () => {
    localStorage.setItem('calimero-desktop-settings', JSON.stringify({ nodeUrl: '' }));
    expect(getSettings().nodeUrl).toBe('http://localhost:2528');
  });

  it('falls back to the default registry when none are stored', () => {
    localStorage.setItem('calimero-desktop-settings', JSON.stringify({ nodeUrl: 'http://localhost:2528', registries: [] }));
    expect(getSettings().registries).toEqual(['https://apps.calimero.network/']);
  });

  it('defaults developerMode, debugLogs, onboardingCompleted and cloudConnected to false', () => {
    localStorage.setItem('calimero-desktop-settings', JSON.stringify({ nodeUrl: 'http://localhost:2528' }));
    const settings = getSettings();
    expect(settings.developerMode).toBe(false);
    expect(settings.debugLogs).toBe(false);
    expect(settings.onboardingCompleted).toBe(false);
    expect(settings.cloudConnected).toBe(false);
  });
});

describe('clearAllAppData', () => {
  it('clears the whole silo, not a fixed list of keys', () => {
    localStorage.setItem('calimero-desktop-settings', '{}');
    localStorage.setItem('calimero-context-keys', '{}');
    localStorage.setItem('calimero_oauth_pending_state', '{}');
    localStorage.setItem('some-key-added-next-year', 'x');
    sessionStorage.setItem('anything', 'x');

    clearAllAppData();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
