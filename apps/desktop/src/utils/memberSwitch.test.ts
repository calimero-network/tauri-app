import { describe, it, expect, vi } from 'vitest';
import { HTTPError } from '@calimero-network/mero-js';

import { behindContexts, behindPhrase, runningLabel, switchNamespace } from './memberSwitch';

const NS = {
  namespaceId: 'ns-1',
  name: 'Team',
  targetApplicationId: 'app-1',
  appVersion: '2.0.0',
  appPackage: 'chat',
};

const ctx = (id: string, groupId: string, applicationVersion?: string) => ({
  id,
  applicationId: 'app-1',
  contextStateHash: '',
  groupId,
  applicationVersion,
});

describe('behindContexts', () => {
  const groups = ['ns-1', 'sub-1'];

  it('lists the held contexts that run another release than the namespace names', () => {
    const held = [ctx('a', 'ns-1', '1.0.0'), ctx('b', 'sub-1', '2.0.0'), ctx('c', 'sub-1', '1.0.0')];
    expect(behindContexts(NS, held, groups).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('ignores contexts of other namespaces', () => {
    expect(behindContexts(NS, [ctx('a', 'other', '1.0.0')], groups)).toEqual([]);
  });

  it('is empty while the namespace release is not known yet', () => {
    expect(behindContexts({ ...NS, appVersion: undefined }, [ctx('a', 'ns-1', '1.0.0')], groups)).toEqual([]);
  });

  it('does not call a context behind when the node names no release for it', () => {
    expect(behindContexts(NS, [ctx('a', 'ns-1')], groups)).toEqual([]);
  });
});

describe('runningLabel', () => {
  const groups = ['ns-1'];

  it('counts the contexts on each release while mixed', () => {
    const held = [ctx('a', 'ns-1', '1.0.0'), ctx('b', 'ns-1', '1.0.0'), ctx('c', 'ns-1', '2.0.0')];
    expect(runningLabel(NS, held, groups)).toBe('1.0.0 on 2, 2.0.0 on 1');
  });

  it('is the bare version when every held context runs it', () => {
    expect(runningLabel(NS, [ctx('a', 'ns-1', '1.0.0'), ctx('b', 'ns-1', '1.0.0')], groups)).toBe('1.0.0');
  });

  it('is the namespace release when no held context names its own', () => {
    expect(runningLabel(NS, [ctx('a', 'ns-1')], groups)).toBe('2.0.0');
  });

  it('says so when this node holds nothing of the namespace yet', () => {
    expect(runningLabel(NS, [], groups)).toBe('not on this node yet');
  });
});

describe('behindPhrase', () => {
  const groups = ['ns-1'];
  const held = [ctx('a', 'ns-1', '1.0.0'), ctx('b', 'ns-1', '1.0.0'), ctx('c', 'ns-1', '2.0.0')];

  it('counts the contexts still behind out of those held', () => {
    expect(behindPhrase(NS, held, groups, 'contexts')).toBe(
      '2 of 3 contexts on this node still run an older release.',
    );
  });

  it('reads in the singular for one context', () => {
    expect(behindPhrase(NS, held.slice(1), groups, 'contexts')).toBe(
      '1 of 2 contexts on this node still runs an older release.',
    );
  });

  it('takes the subject the sentence needs', () => {
    expect(behindPhrase(NS, held, groups, 'of its contexts')).toBe(
      '2 of 3 of its contexts on this node still run an older release.',
    );
  });
});

describe('switchNamespace', () => {
  const activated = { targetApplicationId: 'app-1', switchedContexts: 2, replayedDeltas: 0, failedContexts: [] };

  function mero(over: { install?: (a: { version: string }) => unknown; activate?: () => unknown; missing?: unknown[] } = {}) {
    const installApplication = vi.fn(over.install ?? (async () => ({ applicationId: 'app-1' })));
    const activateGroupUpgrade = vi.fn(over.activate ?? (async () => activated));
    const getGroupMissingReleases = vi.fn(async () => over.missing ?? []);
    return {
      mero: { admin: { installApplication, activateGroupUpgrade, getGroupMissingReleases } } as any,
      installApplication,
      activateGroupUpgrade,
      getGroupMissingReleases,
    };
  }

  const release = (version: string, applicationId = 'app-1') => ({ package: 'chat', version, applicationId });

  it('installs the release first when this node does not hold it, then activates against it', async () => {
    const m = mero();
    const steps: string[] = [];
    const out = await switchNamespace(m.mero, NS, false, (s) => steps.push(s));
    expect(out).toEqual({ kind: 'switched', failed: [] });
    expect(m.installApplication).toHaveBeenCalledWith({ package: 'chat', version: '2.0.0' });
    expect(m.activateGroupUpgrade).toHaveBeenCalledWith('ns-1', {
      expectedApplicationId: 'app-1',
      expectedVersion: '2.0.0',
    });
    expect(steps).toEqual(['installing', 'switching']);
  });

  it('skips the install when the release is already here', async () => {
    const m = mero();
    const steps: string[] = [];
    await switchNamespace(m.mero, NS, true, (s) => steps.push(s));
    expect(m.installApplication).not.toHaveBeenCalled();
    expect(steps).toEqual(['switching']);
  });

  it('refuses a release that installs as another application', async () => {
    const m = mero({ install: async () => ({ applicationId: 'someone-elses-build' }) });
    const out = await switchNamespace(m.mero, NS, false);
    expect(out).toMatchObject({ kind: 'error', message: expect.stringContaining('different application') });
    expect(m.activateGroupUpgrade).not.toHaveBeenCalled();
  });

  it('reports the admin having moved on as moved, not as an error', async () => {
    const m = mero({
      activate: async () => {
        throw new HTTPError(409, 'Conflict', 'http://n/x', new Headers(), '{"error":"target changed"}');
      },
    });
    expect(await switchNamespace(m.mero, NS, true)).toEqual({ kind: 'moved' });
  });

  it('hands back the contexts that failed to switch', async () => {
    const failed = [{ contextId: 'c1', error: 'migration failed', retryable: true }];
    const m = mero({ activate: async () => ({ ...activated, failedContexts: failed }) });
    expect(await switchNamespace(m.mero, NS, true)).toEqual({ kind: 'switched', failed });
  });

  it('turns any other failure into the node message', async () => {
    const m = mero({
      activate: async () => {
        throw new HTTPError(500, 'Server Error', 'http://n/x', new Headers(), '{"error":"disk full"}');
      },
    });
    expect(await switchNamespace(m.mero, NS, true)).toEqual({
      kind: 'error',
      message: 'Could not switch to 2.0.0: disk full',
    });
  });

  it('errors when the namespace names no package to install from', async () => {
    const m = mero();
    const out = await switchNamespace(m.mero, { ...NS, appPackage: undefined }, false);
    expect(out.kind).toBe('error');
    expect(m.installApplication).not.toHaveBeenCalled();
  });

  it('installs every missing release oldest first, then activates', async () => {
    const m = mero({ missing: [release('2.0.0'), release('3.0.0')] });
    const steps: string[] = [];
    const out = await switchNamespace(m.mero, { ...NS, appVersion: '3.0.0' }, true, (s) => steps.push(s));
    expect(out).toEqual({ kind: 'switched', failed: [] });
    expect(m.getGroupMissingReleases).toHaveBeenCalledWith('ns-1');
    expect(m.installApplication.mock.calls.map(([a]) => a)).toEqual([
      { package: 'chat', version: '2.0.0' },
      { package: 'chat', version: '3.0.0' },
    ]);
    expect(m.installApplication.mock.invocationCallOrder[1]).toBeLessThan(m.activateGroupUpgrade.mock.invocationCallOrder[0]!);
    expect(steps).toEqual(['installing', 'switching']);
  });

  it('installs the target last when the node already holds it but misses an earlier release', async () => {
    const m = mero({ missing: [release('2.0.0')] });
    await switchNamespace(m.mero, { ...NS, appVersion: '3.0.0' }, true);
    expect(m.installApplication.mock.calls.map(([a]) => a)).toEqual([
      { package: 'chat', version: '2.0.0' },
      { package: 'chat', version: '3.0.0' },
    ]);
  });

  it('keeps the target install when the node lists no missing releases', async () => {
    const m = mero({ missing: [] });
    await switchNamespace(m.mero, NS, false);
    expect(m.installApplication).toHaveBeenCalledTimes(1);
    expect(m.installApplication).toHaveBeenCalledWith({ package: 'chat', version: '2.0.0' });
  });

  it('stops before activating when a missing release installs as another application', async () => {
    const m = mero({
      missing: [release('2.0.0'), release('3.0.0')],
      install: async ({ version }) => ({ applicationId: version === '2.0.0' ? 'someone-elses-build' : 'app-1' }),
    });
    const out = await switchNamespace(m.mero, NS, true);
    expect(out).toMatchObject({ kind: 'error', message: expect.stringContaining('different application') });
    expect(m.installApplication).toHaveBeenCalledTimes(1);
    expect(m.activateGroupUpgrade).not.toHaveBeenCalled();
  });
});
