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
