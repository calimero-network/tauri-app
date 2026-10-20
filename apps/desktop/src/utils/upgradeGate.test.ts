import { describe, it, expect, vi } from 'vitest';

import { behindNamespaces, confirmAppUpToDate, registerGateHost } from './upgradeGate';

const ns = (namespaceId: string, targetApplicationId: string, appVersion?: string) => ({
  namespaceId,
  targetApplicationId,
  appVersion,
  name: namespaceId,
});

function node(over: Record<string, unknown> = {}) {
  const admin = {
    listNamespaces: vi.fn(async () => [ns('n1', 'app-1', '2.0.0'), ns('n2', 'app-2', '2.0.0')]),
    getContextsForApplication: vi.fn(async () => ({
      contexts: [
        { contextId: 'c1', groupId: 'sub-1', applicationVersion: '1.0.0' },
        { contextId: 'c2', groupId: 'n2', applicationVersion: '1.0.0' },
      ],
    })),
    listNamespaceGroups: vi.fn(async () => [{ groupId: 'sub-1' }]),
    listSubgroups: vi.fn(async () => []),
    ...over,
  };
  return { mero: { admin } as any, admin };
}

describe('behindNamespaces', () => {
  it('finds the namespaces of the app whose subgroup contexts run an older release', async () => {
    const out = await behindNamespaces(node().mero, 'app-1');
    expect(out.map((b) => [b.ns.namespaceId, b.running])).toEqual([['n1', '1.0.0']]);
  });

  it('is empty when every held context is on the namespace release', async () => {
    const { mero } = node({
      getContextsForApplication: vi.fn(async () => ({
        contexts: [{ contextId: 'c1', groupId: 'sub-1', applicationVersion: '2.0.0' }],
      })),
    });
    expect(await behindNamespaces(mero, 'app-1')).toEqual([]);
  });

  it('is empty, without asking for contexts, when no namespace targets the app', async () => {
    const { mero, admin } = node();
    expect(await behindNamespaces(mero, 'app-9')).toEqual([]);
    expect(admin.getContextsForApplication).not.toHaveBeenCalled();
  });

  it('never blocks the app when the node cannot say', async () => {
    const { mero } = node({ listNamespaces: vi.fn(async () => Promise.reject(new Error('down'))) });
    expect(await behindNamespaces(mero, 'app-1')).toEqual([]);
  });
});

describe('confirmAppUpToDate', () => {
  it('lets the app open when no gate is mounted', async () => {
    expect(await confirmAppUpToDate('app-1', 'Chat')).toBe(true);
  });

  it('hands the request to the mounted gate and returns its answer', async () => {
    const off = registerGateHost((req) => req.resolve(false));
    expect(await confirmAppUpToDate('app-1', 'Chat')).toBe(false);
    off();
    expect(await confirmAppUpToDate('app-1', 'Chat')).toBe(true);
  });
});
