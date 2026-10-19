import { describe, it, expect, afterEach } from 'vitest';
import { MemoryTokenStore, MeroJs } from '@calimero-network/mero-js';
import {
  describeStep,
  isBlocked,
  loadAppNamespaces,
  planNamespace,
  uninstallApp,
  type AppNamespace,
  type UninstallChoice,
} from './uninstall';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const node = () => new MeroJs({ baseUrl: 'http://node', tokenStore: new MemoryTokenStore() });

const joined: AppNamespace = { id: 'ns-joined', name: 'Team', role: 'Member', others: 3 };
const ownedAlone: AppNamespace = { id: 'ns-alone', name: 'Notes', role: 'Admin', others: 0 };
const ownedShared: AppNamespace = { id: 'ns-shared', name: 'Family', role: 'Admin', others: 2 };

function choice(overrides: Partial<UninstallChoice> = {}): UninstallChoice {
  return { deleteData: true, leave: true, deleteForEveryone: new Set(), linkedDevice: false, ...overrides };
}

describe('what an uninstall does to each namespace', () => {
  it('leaves a joined namespace when deleting and leaving', () => {
    expect(planNamespace(joined, choice())).toBe('leave');
  });

  it('deletes an owned namespace nobody else is in, without asking', () => {
    expect(planNamespace(ownedAlone, choice())).toBe('delete-for-everyone');
  });

  it('blocks an owned namespace others are in until ownership moves', () => {
    expect(planNamespace(ownedShared, choice())).toBe('needs-transfer');
  });

  it('deletes an owned namespace for everyone once the user confirmed it', () => {
    expect(planNamespace(ownedShared, choice({ deleteForEveryone: new Set(['ns-shared']) }))).toBe(
      'delete-for-everyone',
    );
  });

  it('removes every namespace from this device only when not leaving, whatever the role', () => {
    for (const ns of [joined, ownedAlone, ownedShared]) {
      expect(planNamespace(ns, choice({ leave: false }))).toBe('remove');
    }
  });

  it('touches nothing when the data is kept, even with leave still ticked', () => {
    for (const ns of [joined, ownedAlone, ownedShared]) {
      expect(planNamespace(ns, choice({ deleteData: false }))).toBe('keep');
    }
  });

  it('treats a namespace whose member list did not name us as joined', () => {
    expect(planNamespace({ ...joined, role: undefined }, choice())).toBe('leave');
  });
});

describe('on a linked device', () => {
  const linked = (overrides: Partial<UninstallChoice> = {}) => choice({ linkedDevice: true, ...overrides });

  it('does not attempt an owner-only delete, even for the only member', () => {
    expect(planNamespace(ownedAlone, linked())).toBe('needs-primary-device');
  });

  it('does not attempt a confirmed delete for everyone', () => {
    expect(planNamespace(ownedShared, linked({ deleteForEveryone: new Set(['ns-shared']) }))).toBe(
      'needs-primary-device',
    );
  });

  it('still leaves a joined namespace, which needs no root', () => {
    expect(planNamespace(joined, linked())).toBe('leave');
  });

  it('removes an owned namespace from this device once leave is unticked', () => {
    expect(planNamespace(ownedShared, linked({ leave: false }))).toBe('remove');
  });
});

describe('the uninstall can go ahead', () => {
  it('only when no namespace waits on the user', () => {
    expect(isBlocked(['leave', 'remove', 'delete-for-everyone', 'keep'])).toBe(false);
    expect(isBlocked(['leave', 'needs-transfer'])).toBe(true);
    expect(isBlocked(['needs-primary-device'])).toBe(true);
  });
});

describe('the line each namespace gets', () => {
  it('names the namespace and what happens to it', () => {
    expect(describeStep(joined, 'leave')).toBe('Team: you leave it, and all your devices remove it');
    expect(describeStep(joined, 'remove')).toBe('Team: removed from this device; you stay a member');
    expect(describeStep(joined, 'keep')).toBe('Team: kept on this device');
    expect(describeStep(ownedAlone, 'delete-for-everyone')).toBe('Notes: deleted; you are its only member');
    expect(describeStep(ownedShared, 'delete-for-everyone')).toBe('Family: deleted for all 3 members');
    expect(describeStep(ownedShared, 'needs-transfer')).toBe(
      'Family: you own it and 2 others are members; transfer ownership first',
    );
    expect(describeStep(ownedAlone, 'needs-primary-device')).toBe(
      'Notes: only the computer that holds the account can delete it',
    );
  });

  it('counts a single other member in the singular', () => {
    expect(describeStep({ ...ownedShared, others: 1 }, 'needs-transfer')).toBe(
      'Family: you own it and 1 other is a member; transfer ownership first',
    );
    expect(describeStep({ ...ownedShared, others: 1 }, 'delete-for-everyone')).toBe(
      'Family: deleted for both members',
    );
  });
});

describe('uninstalling an application', () => {
  const ns = (id: string, others = 0) => ({ id, name: `name-${id}`, role: 'Member', others });
  const UNINSTALL = 'DELETE /admin-api/applications/app-1';

  /** Answers every call, except those in `refuse`, which fail with the given response. */
  function fakeNode(refuse: Record<string, () => Response> = {}) {
    const calls: { call: string; body: unknown }[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const call = `${init?.method ?? 'GET'} ${url.pathname}`;
      calls.push({ call, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return refuse[call]?.() ?? new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
    return calls;
  }

  it('makes the call each step names, then uninstalls', async () => {
    const calls = fakeNode();

    const response = await uninstallApp(node(), 'app-1', [
      { ns: ns('a'), action: 'leave' },
      { ns: ns('b'), action: 'remove' },
      { ns: ns('c'), action: 'delete-for-everyone' },
      { ns: ns('d'), action: 'keep' },
    ]);

    expect(response).toEqual({ data: { applicationId: 'app-1' } });
    expect(calls).toEqual([
      { call: 'POST /admin-api/namespaces/a/leave', body: { purge: true } },
      { call: 'DELETE /admin-api/namespaces/b', body: {} },
      { call: 'POST /admin-api/groups/c/owner-delete', body: {} },
      { call: UNINSTALL, body: undefined },
    ]);
  });

  it('stops at the first failure, before the uninstall, and names the namespace', async () => {
    const calls = fakeNode({
      'POST /admin-api/namespaces/a/leave': () =>
        new Response(JSON.stringify({ error: 'the owner cannot leave' }), { status: 403 }),
    });

    const response = await uninstallApp(node(), 'app-1', [
      { ns: ns('a'), action: 'leave' },
      { ns: ns('b'), action: 'remove' },
    ]);

    expect(response.error?.message).toBe('name-a: the owner cannot leave');
    expect(response.error?.code).toBeUndefined();
    expect(calls.map((c) => c.call)).toEqual(['POST /admin-api/namespaces/a/leave']);
  });

  it('aborts on a revoked session with the code that sends the user to sign in', async () => {
    const calls = fakeNode({
      'DELETE /admin-api/namespaces/b': () =>
        new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_revoked' } }),
    });

    const response = await uninstallApp(node(), 'app-1', [{ ns: ns('b'), action: 'remove' }]);

    expect(response.error).toEqual({ message: 'Session revoked', code: '401' });
    expect(calls.map((c) => c.call)).not.toContain(UNINSTALL);
  });

  it('refuses a plan still waiting on the user, without touching anything', async () => {
    const calls = fakeNode();

    const response = await uninstallApp(node(), 'app-1', [
      { ns: ns('a'), action: 'leave' },
      { ns: ns('b', 2), action: 'needs-transfer' },
    ]);

    expect(response.error?.message).toBe('name-b: you own it and 2 others are members; transfer ownership first');
    expect(calls).toEqual([]);
  });

  it('uninstalls alone when no step is given', async () => {
    const calls = fakeNode();

    expect(await uninstallApp(node(), 'app-1', [])).toEqual({ data: { applicationId: 'app-1' } });
    expect(calls.map((c) => c.call)).toEqual([UNINSTALL]);
  });
});

describe('reading what the dialog lists', () => {
  const ME = 'a'.repeat(64);
  const BOB = 'b'.repeat(64);
  const RELAY = 'c'.repeat(64);

  function fakeNode(identity: Response) {
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
      // The member listing is the one route answered without a `data` envelope.
      const members = (list: unknown[]) => new Response(JSON.stringify({ members: list }), { status: 200 });
      switch (url.pathname) {
        case '/admin-api/identity':
          return identity.clone();
        case '/admin-api/namespaces/for-application/app-1':
          return ok([
            { namespaceId: 'ns-team', name: 'Team' },
            { namespaceId: '0123456789abcdef', name: '' },
            { namespaceId: 'ns-gone', name: 'Gone', forgotten: true },
          ]);
        case '/admin-api/groups/ns-team/members':
          return members([
            { identity: ME, role: 'Admin' },
            { identity: BOB, role: 'Member' },
            { identity: RELAY, role: 'RelayTee' },
          ]);
        case '/admin-api/groups/0123456789abcdef/members':
          return members([{ identity: ME, role: 'Member' }]);
        default:
          return new Response('{}', { status: 404 });
      }
    };
  }
  const identity = (holdsAccountRoot: boolean) =>
    new Response(JSON.stringify({ data: { accountId: ME, holdsAccountRoot } }), { status: 200 });

  it('lists the namespaces on this device with our role and who else could take them over', async () => {
    fakeNode(identity(true));

    expect((await loadAppNamespaces(node(), 'app-1')).data).toEqual({
      linkedDevice: false,
      namespaces: [
        { id: 'ns-team', name: 'Team', role: 'Admin', others: 1 },
        { id: '0123456789abcdef', name: '01234567', role: 'Member', others: 0 },
      ],
    });
  });

  it('says when this node is a linked device', async () => {
    fakeNode(identity(false));

    expect((await loadAppNamespaces(node(), 'app-1')).data?.linkedDevice).toBe(true);
  });

  it('reads a node with no account yet as owning nothing', async () => {
    fakeNode(new Response('{}', { status: 404 }));

    const { linkedDevice, namespaces } = (await loadAppNamespaces(node(), 'app-1')).data!;

    expect(linkedDevice).toBe(false);
    expect(namespaces.map((n) => n.role)).toEqual([undefined, undefined]);
  });

  it('answers a revoked session with the code that sends the user to sign in', async () => {
    fakeNode(new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_revoked' } }));

    expect((await loadAppNamespaces(node(), 'app-1')).error).toEqual({ message: 'Session revoked', code: '401' });
  });
});
