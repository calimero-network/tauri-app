import { describe, it, expect, beforeEach, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  normalizeHomeDir,
  findRunningNode,
  detectRunningMerodNodes,
  type RunningMerodNode,
} from './merod';

const OS_HOME = '/Users/dev';
const MANAGED_HOME = '~/.calimero'; // as settings spell it, unresolved

function node(overrides: Partial<RunningMerodNode> = {}): RunningMerodNode {
  return {
    pid: 111,
    node_name: 'default',
    port: 2528,
    swarm_port: 2428,
    home_dir: `${OS_HOME}/.calimero`,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Every "is this node ours?" decision routes through these, and getting it wrong
// put two RocksDB writers on one store.
describe('normalizeHomeDir', () => {
  it('strips a trailing separator', () => {
    expect(normalizeHomeDir('/Users/dev/.calimero/')).toBe('/Users/dev/.calimero');
  });

  it('expands a leading ~/ against the OS home dir', () => {
    expect(normalizeHomeDir('~/.calimero', OS_HOME)).toBe('/Users/dev/.calimero');
  });

  it('expands a bare ~ to the OS home dir', () => {
    expect(normalizeHomeDir('~', OS_HOME)).toBe(OS_HOME);
  });

  it('leaves ~ unexpanded when the OS home dir is unknown', () => {
    expect(normalizeHomeDir('~/.calimero')).toBe('~/.calimero');
  });

  it('is empty for a missing path', () => {
    expect(normalizeHomeDir(undefined)).toBe('');
    expect(normalizeHomeDir(null)).toBe('');
  });
});

describe('findRunningNode', () => {
  it('never matches a node on an unrelated home', () => {
    // The data-loss scenario: a developer's own `merod --home ~/dev-nodes` must
    // not be mistaken for the app's own node.
    const foreign = node({ home_dir: '/Users/dev/dev-nodes/alice', port: 3001 });

    expect(findRunningNode([foreign], MANAGED_HOME, 'default', OS_HOME)).toBeUndefined();
  });

  it('finds the node running under the managed home', () => {
    const ours = node();

    expect(findRunningNode([ours], MANAGED_HOME, 'default', OS_HOME)).toBe(ours);
  });

  it('matches home paths that differ only by a trailing slash', () => {
    const ours = node({ home_dir: `${OS_HOME}/.calimero/` });

    expect(findRunningNode([ours], MANAGED_HOME, 'default', OS_HOME)).toBe(ours);
  });

  it('matches a literal ~ home against the already-resolved absolute home_dir', () => {
    // start_merod resolves `~` before spawning, so the running node's home_dir is
    // absolute even though settings still hold the literal '~/.calimero'.
    const ours = node();

    expect(findRunningNode([ours], '~/.calimero', 'default', OS_HOME)).toBe(ours);
  });

  it('picks the named node, not a sibling sharing the same home', () => {
    // ~/.calimero is merod's own default home, so a hand-started node sits beside
    // the app's; matching on the home alone took whichever came first.
    const handStarted = node({ node_name: 'mydev', port: 3001 });
    const ours = node({ node_name: 'node1' });

    expect(findRunningNode([handStarted, ours], MANAGED_HOME, 'node1', OS_HOME)).toBe(ours);
  });

  it('finds nothing when no node in the managed home has that name', () => {
    const handStarted = node({ node_name: 'mydev', port: 3001 });

    expect(findRunningNode([handStarted], MANAGED_HOME, 'node1', OS_HOME)).toBeUndefined();
  });

  it('ignores a foreign node even when a managed one is also running', () => {
    const foreign = node({ home_dir: '/Users/dev/dev-nodes/alice', port: 3001, pid: 222 });
    const ours = node({ pid: 333 });

    expect(findRunningNode([foreign, ours], MANAGED_HOME, 'default', OS_HOME)).toBe(ours);
  });

  it('resolves to the right PID when two homes both hold a node called "default"', () => {
    const running = [
      node({ pid: 111, home_dir: '/tmp/e2e' }),
      node({ pid: 222, home_dir: `${OS_HOME}/.calimero` }),
    ];

    expect(findRunningNode(running, `${OS_HOME}/.calimero`, 'default')?.pid).toBe(222);
    expect(findRunningNode(running, '/tmp/e2e', 'default')?.pid).toBe(111);
  });

  it('matches nothing when the home dir to look under is unknown', () => {
    // Both an empty home and a node the scan could not place normalize to '', so
    // without the guard they would look like the same directory.
    const unplaceable = node({ home_dir: undefined });

    expect(findRunningNode([unplaceable], '', 'default')).toBeUndefined();
    expect(findRunningNode([unplaceable], `${OS_HOME}/.calimero`, 'default')).toBeUndefined();
  });

  it('cannot match a ~ home until the OS home dir is known', () => {
    // Why the callers resolve it before deciding: a running node reports an
    // absolute path, so an unexpanded "~" reads as "nothing is running".
    const ours = node({ home_dir: `${OS_HOME}/.calimero` });

    expect(findRunningNode([ours], MANAGED_HOME, ours.node_name, '')).toBeUndefined();
    expect(findRunningNode([ours], MANAGED_HOME, ours.node_name, OS_HOME)).toBe(ours);
  });

  it('matches nothing when no node is configured, rather than any node in the home', () => {
    // The home alone can match several nodes, so an unnamed lookup would adopt
    // whichever the scan listed first and hand the UI a node the user never chose.
    const ours = node({ node_name: 'whatever' });

    expect(findRunningNode([ours], MANAGED_HOME, '', OS_HOME)).toBeUndefined();
  });
});

describe('detectRunningMerodNodes', () => {
  it('returns an array when the command resolves null, so no caller has to re-check', async () => {
    invoke.mockResolvedValue(null);

    await expect(detectRunningMerodNodes()).resolves.toEqual([]);
  });

  it('passes the reported nodes through', async () => {
    const running = [node()];
    invoke.mockResolvedValue(running);

    await expect(detectRunningMerodNodes()).resolves.toEqual(running);
  });
});
