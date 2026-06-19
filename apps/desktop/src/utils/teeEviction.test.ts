import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  enumerateGroupTree,
  evictTeeMembersFromTree,
  reconcileDisabledNamespaces,
  teeIdentitiesFromMembers,
  extractMembersFromResponse,
  buildEvictionDeps,
  type EvictionDeps,
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

describe('extractMembersFromResponse', () => {
  it('reads a direct members array', () => {
    expect(extractMembersFromResponse({ members: [{ identity: 'a' }] })).toEqual([
      { identity: 'a' },
    ]);
  });
  it('reads a wrapped data.members array', () => {
    expect(
      extractMembersFromResponse({ data: { members: [{ identity: 'b' }] } }),
    ).toEqual([{ identity: 'b' }]);
  });
  it('returns null on unrecognised shape (fail-closed)', () => {
    expect(extractMembersFromResponse({})).toBeNull();
    expect(extractMembersFromResponse(null)).toBeNull();
    expect(extractMembersFromResponse({ members: 'nope' })).toBeNull();
  });
});

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

  it('lists members via the local node token (fail-closed when no token)', async () => {
    const fetchImpl = vi.fn();
    const deps = buildEvictionDeps({
      mero: { admin: { listSubgroups: async () => [], removeGroupMembers: async () => {} } },
      nodeUrl: 'http://node',
      getNodeToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await deps.listGroupMembers('ns');
    expect(res).toBeNull();
    // No token → we must not even hit the network.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists members with a Bearer node token and normalises the body', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer node-tok',
      );
      return new Response(
        JSON.stringify({ members: [{ identity: 'fleet', role: 'ReadOnlyTee' }] }),
        { status: 200 },
      );
    });
    const deps = buildEvictionDeps({
      mero: { admin: { listSubgroups: async () => [], removeGroupMembers: async () => {} } },
      nodeUrl: 'http://node',
      getNodeToken: () => 'node-tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await deps.listGroupMembers('ns');
    expect(res).toEqual([{ identity: 'fleet', role: 'ReadOnlyTee' }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns null on a non-ok members response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const deps = buildEvictionDeps({
      mero: { admin: { listSubgroups: async () => [], removeGroupMembers: async () => {} } },
      nodeUrl: 'http://node',
      getNodeToken: () => 'node-tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await deps.listGroupMembers('ns')).toBeNull();
  });

  it('maps SubgroupEntry[] to a string[] of group ids', async () => {
    const deps = buildEvictionDeps({
      mero: {
        admin: {
          listSubgroups: async () => [
            { groupId: 'a', name: 'A' },
            { groupId: 'b' },
            { groupId: '' }, // dropped
          ],
          removeGroupMembers: async () => {},
        },
      },
      nodeUrl: 'http://node',
      getNodeToken: () => 'node-tok',
    });
    expect(await deps.listSubgroups('ns')).toEqual(['a', 'b']);
  });

  it('forwards removals to mero.admin.removeGroupMembers', async () => {
    const removeGroupMembers = vi.fn(async () => {});
    const deps = buildEvictionDeps({
      mero: { admin: { listSubgroups: async () => [], removeGroupMembers } },
      nodeUrl: 'http://node',
      getNodeToken: () => 'node-tok',
    });
    await deps.removeGroupMembers('ns', ['fleet']);
    expect(removeGroupMembers).toHaveBeenCalledWith('ns', { members: ['fleet'] });
  });
});
