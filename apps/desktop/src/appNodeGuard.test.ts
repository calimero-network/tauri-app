import { describe, it, expect } from 'vitest';
import type { RunningMerodNode } from './utils/merod';
import { decideManagedNodes, decideRestartAction, shouldStartMerod } from './App';

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
  it('auto-starts and never adopts when the only node running is on an unrelated home', () => {
    // The data-loss scenario: a developer's own `merod --home ~/dev-nodes` must
    // not be mistaken for the app's own node.
    const foreign = node({ home_dir: '/Users/dev/dev-nodes/alice', port: 3001 });

    const decision = decideManagedNodes([foreign], MANAGED_HOME, OS_HOME);

    expect(decision.shouldAutoStart).toBe(true);
    expect(decision.adopt).toBeUndefined();
  });

  it('adopts a node running under the managed home and skips auto-start', () => {
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, port: 2528 });

    const decision = decideManagedNodes([ours], MANAGED_HOME, OS_HOME);

    expect(decision.shouldAutoStart).toBe(false);
    expect(decision.adopt).toBe(ours);
  });

  it('matches home paths that differ only by a trailing slash', () => {
    const ours = node({ home_dir: `${OS_HOME}/.calimero/`, port: 2528 });

    const decision = decideManagedNodes([ours], MANAGED_HOME, OS_HOME);

    expect(decision.shouldAutoStart).toBe(false);
    expect(decision.adopt).toBe(ours);
  });

  it('matches a literal ~ managed home against the already-resolved absolute home_dir', () => {
    // start_merod resolves `~` before spawning, so the running node's home_dir
    // is absolute even though settings still holds the literal '~/.calimero'.
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, port: 2528 });

    const decision = decideManagedNodes([ours], '~/.calimero', OS_HOME);

    expect(decision.adopt).toBe(ours);
  });

  it('ignores a foreign node even when a managed one is also running', () => {
    const foreign = node({ home_dir: '/Users/dev/dev-nodes/alice', port: 3001, pid: 222 });
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, port: 2528, pid: 333 });

    const decision = decideManagedNodes([foreign, ours], MANAGED_HOME, OS_HOME);

    expect(decision.shouldAutoStart).toBe(false);
    expect(decision.adopt).toBe(ours);
  });
});

describe('shouldStartMerod', () => {
  it('is true whenever an embedded node is configured - the backend decides whether to adopt or spawn', () => {
    expect(shouldStartMerod('node1')).toBe(true);
  });

  it('is false when no embedded node is configured', () => {
    expect(shouldStartMerod(undefined)).toBe(false);
  });

  it('still calls the backend even when a node is already running in the managed home', () => {
    // Regression guard for the data-loss incident: this must not be gated on
    // decideManagedNodes' shouldAutoStart. That used to skip the call for an
    // already-running managed node, so it never entered the backend's tracked
    // state and survived an app quit.
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, port: 2528 });
    const decision = decideManagedNodes([ours], MANAGED_HOME, OS_HOME);

    expect(decision.shouldAutoStart).toBe(false);
    expect(shouldStartMerod('node1')).toBe(true);
  });
});

describe('decideRestartAction', () => {
  const settings = { embeddedNodeName: 'node1', embeddedNodeDataDir: '~/.calimero' };

  it('reconnects instead of spawning when the node is already running', () => {
    const ours = node({ home_dir: `${OS_HOME}/.calimero`, node_name: 'node1', port: 2528 });

    expect(decideRestartAction([ours], settings, OS_HOME)).toBe('reconnect');
  });

  it('does not read an unauthenticated (401) node as dead — reconnect still wins', () => {
    // A 401 is an HTTP-layer signal from checkConnection; this decision is made
    // purely from the OS process list, so it never sees the 401 at all — the
    // running node is enough to choose reconnect over start.
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
