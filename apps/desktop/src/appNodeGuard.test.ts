import { describe, it, expect } from 'vitest';
import type { RunningMerodNode } from './utils/merod';
import { decideManagedNodes, decideRestartAction } from './App';

const OS_HOME = '/Users/dev';
const MANAGED_HOME = '~/.calimero'; // settings default, unresolved

function node(overrides: Partial<RunningMerodNode> = {}): RunningMerodNode {
  return {
    pid: 111,
    node_name: 'node1',
    port: 2528,
    home_dir: `${OS_HOME}/.calimero`,
    ...overrides,
  };
}

describe('decideManagedNodes', () => {
  it('never adopts when the only node running is on an unrelated home', () => {
    // The data-loss scenario: a developer's own `merod --home ~/dev-nodes` must
    // not be mistaken for the app's own node.
    const foreign = node({ home_dir: '/Users/dev/dev-nodes/alice', port: 3001 });

    expect(decideManagedNodes([foreign], MANAGED_HOME, OS_HOME)).toBeUndefined();
  });

  it('adopts a node running under the managed home', () => {
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, port: 2528 });

    expect(decideManagedNodes([ours], MANAGED_HOME, OS_HOME)).toBe(ours);
  });

  it('matches home paths that differ only by a trailing slash', () => {
    const ours = node({ home_dir: `${OS_HOME}/.calimero/`, port: 2528 });

    expect(decideManagedNodes([ours], MANAGED_HOME, OS_HOME)).toBe(ours);
  });

  it('adopts the app\'s own node, not a sibling sharing the same home', () => {
    // ~/.calimero is merod's own default home, so a hand-started node sits beside
    // the app's; matching on the home alone adopted whichever came first.
    const handStarted = node({ node_name: 'mydev', port: 3001 });
    const ours = node({ node_name: 'node1', port: 2528 });

    expect(decideManagedNodes([handStarted, ours], MANAGED_HOME, OS_HOME, 'node1')).toBe(ours);
  });

  it('adopts nothing when no node in the managed home has the configured name', () => {
    const handStarted = node({ node_name: 'mydev', port: 3001 });

    expect(
      decideManagedNodes([handStarted], MANAGED_HOME, OS_HOME, 'node1')
    ).toBeUndefined();
  });

  it('matches a literal ~ managed home against the already-resolved absolute home_dir', () => {
    // start_merod resolves `~` before spawning, so the running node's home_dir
    // is absolute even though settings still holds the literal '~/.calimero'.
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, port: 2528 });

    expect(decideManagedNodes([ours], '~/.calimero', OS_HOME)).toBe(ours);
  });

  it('ignores a foreign node even when a managed one is also running', () => {
    const foreign = node({ home_dir: '/Users/dev/dev-nodes/alice', port: 3001, pid: 222 });
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, port: 2528, pid: 333 });

    expect(decideManagedNodes([foreign, ours], MANAGED_HOME, OS_HOME)).toBe(ours);
  });
});

describe('decideRestartAction', () => {
  const settings = { embeddedNodeName: 'node1', embeddedNodeDataDir: '~/.calimero' };

  it('reconnects instead of spawning when the node is already running', () => {
    // Decided from the OS process list, so a 401 (unauthenticated but alive) never
    // reaches it.
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, node_name: 'node1', port: 2528 });

    expect(decideRestartAction([ours], settings, OS_HOME)).toBe('reconnect');
  });

  it('starts a fresh node when nothing is running for this home+name', () => {
    expect(decideRestartAction([], settings, OS_HOME)).toBe('start');
  });

  it('starts fresh when only a foreign-home node is running, not reconnect to it', () => {
    const foreign = node({ home_dir: '/Users/dev/dev-nodes/alice', node_name: 'node1', port: 3001 });

    expect(decideRestartAction([foreign], settings, OS_HOME)).toBe('start');
  });

  it('starts fresh when a managed-home node is running under a different name', () => {
    const otherNode = node({ home_dir: `${OS_HOME}/.calimero`, node_name: 'someone-else', port: 2528 });

    expect(decideRestartAction([otherNode], settings, OS_HOME)).toBe('start');
  });

  it('sends the user to node management when no embedded node is configured', () => {
    expect(decideRestartAction([], {}, OS_HOME)).toBe('manage');
  });
});
