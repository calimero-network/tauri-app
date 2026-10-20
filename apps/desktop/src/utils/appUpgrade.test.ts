import { describe, it, expect } from 'vitest';

import { isNewer, planUpgrade, readUpgradeProgress } from './appUpgrade';

describe('isNewer', () => {
  it('compares by semver, not as text', () => {
    expect(isNewer('3.1.37', '3.1.9')).toBe(true);
    expect(isNewer('3.1.9', '3.1.37')).toBe(false);
    expect(isNewer('3.1.37', '3.1.37')).toBe(false);
  });

  it('ranks a release above its own pre-release', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
  });

  it('never calls a missing version newer, and anything newer than a missing one', () => {
    expect(isNewer(null, '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', null)).toBe(true);
  });
});

describe('planUpgrade', () => {
  it('installs a newer published release before anything else', () => {
    expect(planUpgrade({ running: '3.1.36', installed: '3.1.36', published: '3.1.37' })).toEqual({
      kind: 'install',
      version: '3.1.37',
    });
  });

  it('offers the upgrade once this node holds a release newer than the namespace runs', () => {
    expect(planUpgrade({ running: '3.1.36', installed: '3.1.37', published: '3.1.37' })).toEqual({
      kind: 'upgrade',
      version: '3.1.37',
    });
  });

  it('still offers the upgrade when the registry cannot be reached', () => {
    expect(planUpgrade({ running: '3.1.36', installed: '3.1.37', published: null })).toEqual({
      kind: 'upgrade',
      version: '3.1.37',
    });
  });

  it('is current when the namespace runs the newest release', () => {
    expect(planUpgrade({ running: '3.1.37', installed: '3.1.37', published: '3.1.37' })).toEqual({
      kind: 'current',
    });
  });

  // Another admin upgraded the namespace from their node. From rc.90 core names
  // the target's version here before this node holds it (core#4607); the node
  // fetches the release when a context is next used, so it is not up to date
  // and there is nothing to install or upgrade.
  it('does not hold the release when the namespace is ahead of what this node installed', () => {
    expect(planUpgrade({ running: '3.1.37', installed: '3.1.36', published: '3.1.37' })).toEqual({
      kind: 'unknown',
    });
  });

  it('does not hold the release when its application is not installed here', () => {
    expect(planUpgrade({ running: '3.1.37', installed: null, published: '3.1.38' })).toEqual({
      kind: 'unknown',
    });
  });

  it('cannot plan without the running version', () => {
    expect(planUpgrade({ running: undefined, installed: '3.1.37', published: '3.1.38' })).toEqual({
      kind: 'unknown',
    });
  });
});

describe('readUpgradeProgress', () => {
  const row = { fromVersion: '3.1.36', toVersion: '3.1.37' };

  it('is nothing without an upgrade row', () => {
    expect(readUpgradeProgress(null)).toEqual({ kind: 'none' });
  });

  it('reads core in_progress as running, with the swap count', () => {
    expect(
      readUpgradeProgress({ ...row, status: 'in_progress', localContextsSwapped: 2, localContextsTotal: 5 }),
    ).toEqual({ kind: 'running', from: '3.1.36', to: '3.1.37', swapped: 2, total: 5 });
  });

  it('reads completed as done', () => {
    expect(readUpgradeProgress({ ...row, status: 'completed' })).toEqual({
      kind: 'done',
      from: '3.1.36',
      to: '3.1.37',
    });
  });

  it('reports failed swaps whatever the status says', () => {
    expect(readUpgradeProgress({ ...row, status: 'completed', localContextsFailed: 1 })).toEqual({
      kind: 'failed',
      from: '3.1.36',
      to: '3.1.37',
      failed: 1,
    });
  });
});
