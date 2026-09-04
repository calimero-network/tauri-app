import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enumerateGroupTree,
  evictTeeMembersFromTree,
  reconcileDisabledNamespaces,
  teeIdentitiesFromMembers,
  buildEvictionDeps,
  type EvictionDeps,
  type MeroAdminLike,
} from './teeEviction';

// ── A tiny in-memory merod model ──────────────────────────────────────
//
// Models the owner's local group ledger: a tree of groups, each with a
// members list. Lets the tests assert exactly which (group, identity)
// removals the kick issues across the whole namespace tree.

interface FakeMember {
  identity: string;
  role: string;
}

function makeModel(spec: {
  // groupId -> direct child groupIds
  tree: Record<string, string[]>;
  // groupId -> members
  members: Record<string, FakeMember[]>;
}): {
  deps: EvictionDeps;
  removed: { groupId: string; identities: string[] }[];
} {
  const tree = spec.tree;
  const members = structuredClone(spec.members);
  const removed: { groupId: string; identities: string[] }[] = [];
  const deps: EvictionDeps = {
    listSubgroups: async (groupId) => tree[groupId] ?? [],
    listGroupMembers: async (groupId) => members[groupId] ?? [],
    removeGroupMembers: async (groupId, identities) => {
      removed.push({ groupId, identities });
      const present = members[groupId] ?? [];
      members[groupId] = present.filter((m) => !identities.includes(m.identity));
    },
  };
  return { deps, removed };
}

describe('teeIdentitiesFromMembers', () => {
  it('keeps only ReadOnlyTee identities', () => {
    const raw = [
      { identity: 'admin1', role: 'Admin' },
      { identity: 'tee1', role: 'ReadOnlyTee' },
      { identity: 'ro1', role: 'ReadOnly' },
      { identity: 'tee2', role: 'ReadOnlyTee' },
      { role: 'ReadOnlyTee' }, // missing identity → dropped
      { identity: 42, role: 'ReadOnlyTee' }, // non-string identity → dropped
    ];
    expect(teeIdentitiesFromMembers(raw)).toEqual(['tee1', 'tee2']);
  });
});

describe('enumerateGroupTree', () => {
  it('walks root + nested subgroups, deduped, cycle-safe', async () => {
    const { deps } = makeModel({
      tree: {
        root: ['a', 'b'],
        a: ['a1'],
        a1: ['root'], // cycle back to root — must not loop
        b: [],
      },
      members: {},
    });
    const { groupIds, incomplete } = await enumerateGroupTree(deps, 'root');
    expect(incomplete).toBe(false);
    expect(new Set(groupIds)).toEqual(new Set(['root', 'a', 'b', 'a1']));
    // root is visited first (drives the TEE self-purge)
    expect(groupIds[0]).toBe('root');
  });

  it('marks incomplete when a subgroup listing throws but keeps the rest', async () => {
    const deps: Pick<EvictionDeps, 'listSubgroups'> = {
      listSubgroups: async (groupId) => {
        if (groupId === 'root') return ['ok', 'bad'];
        if (groupId === 'bad') throw new Error('boom');
        return [];
      },
    };
    const { groupIds, incomplete } = await enumerateGroupTree(deps, 'root');
    expect(incomplete).toBe(true);
    expect(new Set(groupIds)).toEqual(new Set(['root', 'ok', 'bad']));
  });
});

describe('evictTeeMembersFromTree', () => {
  it('removes ReadOnlyTee from the root AND every subgroup (Bug 2)', async () => {
    const { deps, removed } = makeModel({
      tree: {
        ns: ['private', 'public'],
        private: ['private-nested'],
        public: [],
        'private-nested': [],
      },
      members: {
        ns: [
          { identity: 'owner', role: 'Admin' },
          { identity: 'fleet', role: 'ReadOnlyTee' },
        ],
        private: [
          { identity: 'owner', role: 'Admin' },
          { identity: 'fleet', role: 'ReadOnlyTee' },
        ],
        'private-nested': [{ identity: 'fleet', role: 'ReadOnlyTee' }],
        public: [{ identity: 'owner', role: 'Admin' }], // no TEE
      },
    });

    const result = await evictTeeMembersFromTree(deps, 'ns');

    expect(result.listFailed).toBe(false);
    expect(result.groupsVisited).toBe(4);
    expect(result.evicted).toBe(3);
    expect(result.failed).toBe(0);

    // The TEE was removed from ns root, private subgroup, AND the nested
    // private subgroup — but never from `public` (no TEE there).
    const byGroup = removed.map((r) => r.groupId).sort();
    expect(byGroup).toEqual(['ns', 'private', 'private-nested']);
    for (const r of removed) expect(r.identities).toEqual(['fleet']);
  });

  it('is idempotent — a clean tree is a no-op', async () => {
    const { deps, removed } = makeModel({
      tree: { ns: ['private'], private: [] },
      members: {
        ns: [{ identity: 'owner', role: 'Admin' }],
        private: [{ identity: 'owner', role: 'Admin' }],
      },
    });
    const result = await evictTeeMembersFromTree(deps, 'ns');
    expect(result.evicted).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.listFailed).toBe(false);
    expect(removed).toHaveLength(0);
  });

  it('counts a benign remove error as failed (already-gone member)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: EvictionDeps = {
      listSubgroups: async () => [],
      listGroupMembers: async () => [{ identity: 'fleet', role: 'ReadOnlyTee' }],
      removeGroupMembers: async () => {
        throw new Error('not a member');
      },
    };
    const result = await evictTeeMembersFromTree(deps, 'ns');
    expect(result.evicted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.listFailed).toBe(false);
    warn.mockRestore();
  });

  it('reports listFailed when the root members listing fails (fail-closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: EvictionDeps = {
      listSubgroups: async () => [],
      listGroupMembers: async () => null, // couldn't tell
      removeGroupMembers: async () => {},
    };
    const result = await evictTeeMembersFromTree(deps, 'ns');
    expect(result.listFailed).toBe(true);
    expect(result.evicted).toBe(0);
    warn.mockRestore();
  });

  it('does no enumeration or removes when shouldAbort is already true at entry', async () => {
    const { deps, removed } = makeModel({
      tree: { ns: ['sub'], sub: [] },
      members: { ns: [{ identity: 'fleet', role: 'ReadOnlyTee' }] },
    });
    const listSubgroups = vi.fn(deps.listSubgroups);
    const result = await evictTeeMembersFromTree(
      { ...deps, listSubgroups: listSubgroups as typeof deps.listSubgroups },
      'ns',
      { shouldAbort: () => true },
    );
    expect(result).toEqual({ evicted: 0, failed: 0, listFailed: true, groupsVisited: 0 });
    expect(listSubgroups).not.toHaveBeenCalled();
    expect(removed).toHaveLength(0);
  });

  it('stops issuing removes once shouldAbort flips true (e.g. HA re-enabled)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, removed } = makeModel({
      tree: { ns: ['sub'], sub: [] },
      members: {
        ns: [{ identity: 'fleet', role: 'ReadOnlyTee' }],
        sub: [{ identity: 'fleet', role: 'ReadOnlyTee' }],
      },
    });
    let aborted = false;
    const origRemove = deps.removeGroupMembers;
    deps.removeGroupMembers = async (g, ids) => {
      await origRemove(g, ids);
      aborted = true; // abort right after the first (root) remove
    };
    const result = await evictTeeMembersFromTree(deps, 'ns', {
      shouldAbort: () => aborted,
    });
    // Root was evicted, but the subgroup walk stopped — never touched `sub`.
    expect(result.evicted).toBe(1);
    expect(removed).toEqual([{ groupId: 'ns', identities: ['fleet'] }]);
    // Aborting leaves the tree partially walked → reported incomplete.
    expect(result.listFailed).toBe(true);
    warn.mockRestore();
  });

  it('propagates incomplete enumeration as listFailed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: EvictionDeps = {
      listSubgroups: async (g) => {
        if (g === 'ns') return ['bad'];
        throw new Error('subgroup unreadable');
      },
      listGroupMembers: async () => [],
      removeGroupMembers: async () => {},
    };
    const result = await evictTeeMembersFromTree(deps, 'ns');
    expect(result.listFailed).toBe(true);
    warn.mockRestore();
  });
});

describe('reconcileDisabledNamespaces', () => {
  it('evicts only for namespaces the cloud reports as HA-disabled', async () => {
    const { deps, removed } = makeModel({
      tree: { 'ns-off': ['sub-off'], 'sub-off': [], 'ns-on': [], 'ns-unknown': [] },
      members: {
        // disabled-in-cloud namespace still has a stranded TEE in a subgroup
        'ns-off': [{ identity: 'owner', role: 'Admin' }],
        'sub-off': [{ identity: 'fleet', role: 'ReadOnlyTee' }],
        // enabled namespace also has a TEE — must NOT be touched
        'ns-on': [{ identity: 'fleet2', role: 'ReadOnlyTee' }],
        // unknown (undefined) state — must NOT be touched
        'ns-unknown': [{ identity: 'fleet3', role: 'ReadOnlyTee' }],
      },
    });

    const results = await reconcileDisabledNamespaces(deps, {
      'ns-off': false,
      'ns-on': true,
      // 'ns-unknown' intentionally absent → undefined
    });

    // Only the disabled namespace's TEE (in its subgroup) was removed.
    expect(removed).toEqual([{ groupId: 'sub-off', identities: ['fleet'] }]);
    expect(results['ns-off']?.evicted).toBe(1);
    expect(results['ns-on']).toBeUndefined();
    expect(results['ns-unknown']).toBeUndefined();
  });

  it('skips disabled namespaces with no local TEE members (steady state)', async () => {
    const { deps, removed } = makeModel({
      tree: { ns: [] },
      members: { ns: [{ identity: 'owner', role: 'Admin' }] },
    });
    const results = await reconcileDisabledNamespaces(deps, { ns: false });
    expect(removed).toHaveLength(0);
    expect(results.ns).toBeUndefined();
  });
});

describe('buildEvictionDeps', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const fakeMero = (
    admin: Partial<MeroAdminLike['admin']>,
  ): MeroAdminLike => ({
    admin: {
      listGroupMembers: async () => ({ members: [] }),
      listSubgroups: async () => [],
      removeGroupMembers: async () => {},
      ...admin,
    },
  });

  it('hands back the members the admin client listed', async () => {
    const deps = buildEvictionDeps({
      mero: fakeMero({
        listGroupMembers: async () => ({
          members: [{ identity: 'fleet', role: 'ReadOnlyTee' }],
        }),
      }),
    });
    expect(await deps.listGroupMembers('ns')).toEqual([
      { identity: 'fleet', role: 'ReadOnlyTee' },
    ]);
  });

  it('fails closed (null, not a throw) when the admin client refuses', async () => {
    const deps = buildEvictionDeps({
      mero: fakeMero({
        listGroupMembers: async () => {
          throw new Error('HTTP 401 Unauthorized');
        },
      }),
    });
    expect(await deps.listGroupMembers('ns')).toBeNull();
  });

  it('fails closed without a call once the caller is superseded', async () => {
    const listGroupMembers = vi.fn(async () => ({ members: [] }));
    const controller = new AbortController();
    controller.abort();
    const deps = buildEvictionDeps({
      mero: fakeMero({ listGroupMembers }),
      signal: controller.signal,
    });
    expect(await deps.listGroupMembers('ns')).toBeNull();
    expect(listGroupMembers).not.toHaveBeenCalled();
  });

  it('fails closed when the members call hangs (deadline)', async () => {
    vi.useFakeTimers();
    try {
      const deps = buildEvictionDeps({
        mero: fakeMero({
          listGroupMembers: () => new Promise<{ members: unknown[] }>(() => {}),
        }),
      });
      const pending = deps.listGroupMembers('ns');
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects listSubgroups when the admin call hangs (deadline)', async () => {
    vi.useFakeTimers();
    try {
      const deps = buildEvictionDeps({
        mero: fakeMero({
          listSubgroups: () => new Promise<{ groupId: string }[]>(() => {}), // never resolves
        }),
      });
      const pending = deps.listSubgroups('ns');
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps SubgroupEntry[] to a string[] of group ids', async () => {
    const deps = buildEvictionDeps({
      mero: fakeMero({
        listSubgroups: async () => [
          { groupId: 'a', name: 'A' },
          { groupId: 'b' },
          { groupId: '' }, // dropped
        ],
      }),
    });
    expect(await deps.listSubgroups('ns')).toEqual(['a', 'b']);
  });

  it('forwards removals to mero.admin.removeGroupMembers', async () => {
    const removeGroupMembers = vi.fn(async () => {});
    const deps = buildEvictionDeps({ mero: fakeMero({ removeGroupMembers }) });
    await deps.removeGroupMembers('ns', ['fleet']);
    expect(removeGroupMembers).toHaveBeenCalledWith('ns', { members: ['fleet'] });
  });
});
