import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/** The three keys the desktop has always persisted. Renaming one, or changing
 *  what it holds, logs every existing user out on upgrade. */
const ACCESS_KEY = 'calimero_access_token';
const REFRESH_KEY = 'calimero_refresh_token';
const EXPIRES_KEY = 'calimero_token_expires_at';

/** `exp` 2_000_000_000 (2033-05-18), so the JWT branch is never the fallback. */
const EXP_SECONDS = 2_000_000_000;

function jwtWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const {
  createClientAsync,
  leaveNamespacePurging,
  listForgottenNamespaces,
  rejoinNamespace,
  restoreForgottenNamespaces,
  transferNamespaceOwnership,
} = await import('./mero-client');

const realFetch = globalThis.fetch;

function respondWith(response: () => Response): void {
  globalThis.fetch = async () => response();
}

beforeEach(() => store.clear());
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('the persisted token format', () => {
  it('writes the three keys the app has always written', async () => {
    const client = await createClientAsync({ baseUrl: 'http://localhost:2528' });
    const access = jwtWithExp(EXP_SECONDS);

    // 0 is what the login paths pass: the SDK reads `exp` off the JWT itself.
    client.meroJs.setTokenData({
      access_token: access,
      refresh_token: 'refresh',
      expires_at: 0,
    });

    expect(store.get(ACCESS_KEY)).toBe(access);
    expect(store.get(REFRESH_KEY)).toBe('refresh');
    expect(store.get(EXPIRES_KEY)).toBe(String(EXP_SECONDS * 1000));
  });

  it('adopts a bundle an earlier version left behind', async () => {
    store.set(ACCESS_KEY, 'stored-access');
    store.set(REFRESH_KEY, 'stored-refresh');
    store.set(EXPIRES_KEY, '1700000000000');

    const client = await createClientAsync({ baseUrl: 'http://localhost:2528' });

    expect(client.meroJs.getTokenData()).toEqual({
      access_token: 'stored-access',
      refresh_token: 'stored-refresh',
      expires_at: 1700000000000,
    });
  });

  it('clears all three, so a sign-out leaves nothing to resume from', async () => {
    const client = await createClientAsync({ baseUrl: 'http://localhost:2528' });
    client.meroJs.setTokenData({
      access_token: jwtWithExp(EXP_SECONDS),
      refresh_token: 'refresh',
      expires_at: 0,
    });

    client.meroJs.clearToken();

    expect(store.has(ACCESS_KEY)).toBe(false);
    expect(store.has(REFRESH_KEY)).toBe(false);
    expect(store.has(EXPIRES_KEY)).toBe(false);
  });
});

describe('unauthorized detection', () => {
  it('names a 401 with the code the app routes back to login on', async () => {
    const client = await createClientAsync({ baseUrl: 'http://node' });
    respondWith(() => new Response('{}', { status: 401 }));

    expect(await client.node.healthCheck()).toEqual({
      error: { message: 'Unauthorized', code: '401' },
    });
  });

  it('reads the status, not the message: a 500 that mentions 401 is not a sign-out', async () => {
    const client = await createClientAsync({ baseUrl: 'http://node' });
    respondWith(
      () => new Response(JSON.stringify({ error: 'upstream answered 401' }), { status: 500 }),
    );

    const response = await client.node.healthCheck();

    expect(response.error?.code).toBeUndefined();
    expect(response.error?.message).toContain('upstream answered 401');
  });

  it('carries the same code for a revoked family, which no retry can recover', async () => {
    const client = await createClientAsync({ baseUrl: 'http://node' });
    respondWith(
      () => new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_reuse' } }),
    );

    expect(await client.node.healthCheck()).toEqual({
      error: { message: 'Session revoked', code: '401' },
    });
  });
});

describe('leaving a namespace as an account', () => {
  it('asks every device of the account to purge it', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls: { call: string; body: unknown }[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push({ call: `${init?.method} ${url.pathname}`, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };

    await leaveNamespacePurging(meroJs, 'ns-1');

    expect(calls).toEqual([{ call: 'POST /admin-api/namespaces/ns-1/leave', body: { purge: true } }]);
  });
});

describe('restoring forgotten namespaces', () => {
  function fakeNode(entries: unknown[], refuseJoin: string[] = []) {
    const calls: { call: string; body: unknown }[] = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const call = `${init?.method ?? 'GET'} ${url.pathname}`;
      calls.push({ call, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (call === 'GET /admin-api/namespaces/for-application/app-1') {
        return new Response(JSON.stringify({ data: entries }), { status: 200 });
      }
      if (refuseJoin.some((id) => call === `POST /admin-api/namespaces/${id}/join`)) {
        return new Response(JSON.stringify({ error: 'not a member' }), { status: 403 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
    return calls;
  }

  it('lists only the namespaces flagged forgotten', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    fakeNode([
      { namespaceId: 'here', name: 'Here' },
      { namespaceId: 'gone', name: 'Gone', forgotten: true },
    ]);

    expect((await listForgottenNamespaces(meroJs, 'app-1')).map((n) => n.namespaceId)).toEqual(['gone']);
  });

  it('rejoins a namespace without an invitation', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode([]);

    await rejoinNamespace(meroJs, 'gone');

    expect(calls).toEqual([{ call: 'POST /admin-api/namespaces/gone/join', body: {} }]);
  });

  it('rejoins each forgotten namespace and says which came back and which did not', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode(
      [
        { namespaceId: 'here', name: 'Here' },
        { namespaceId: 'a', name: 'Team', forgotten: true },
        { namespaceId: 'b', forgotten: true },
      ],
      ['b'],
    );

    expect(await restoreForgottenNamespaces(meroJs, 'app-1')).toEqual({
      restored: ['Team'],
      failed: ['b: not a member'],
    });
    expect(calls.map((c) => c.call)).toEqual([
      'GET /admin-api/namespaces/for-application/app-1',
      'POST /admin-api/namespaces/a/join',
      'POST /admin-api/namespaces/b/join',
    ]);
  });

  it('reports a listing it could not read as a failure, without throwing', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'down' }), { status: 500 });

    expect(await restoreForgottenNamespaces(meroJs, 'app-1')).toEqual({ restored: [], failed: ['down'] });
  });
});

describe('transferring a namespace', () => {
  const NS = 'ns-1';
  const BOB = 'b'.repeat(64);
  const TRANSFER = `POST /admin-api/groups/${NS}/transfer-ownership`;
  const PROMOTE = `PUT /admin-api/groups/${NS}/members/${BOB}/role`;

  /** Core's order: the owner check first (403), then the successor must be an admin (409). */
  function fakeNode(
    opts: { admin?: boolean; conflict?: boolean; notOwner?: boolean; roleRefused?: boolean; secondTransferRefused?: boolean } = {},
  ) {
    let admin = opts.admin ?? false;
    const calls: { call: string; body: unknown }[] = [];
    const refuse = (status: number, error: string) => new Response(JSON.stringify({ error }), { status });
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const call = `${init?.method ?? 'GET'} ${url.pathname}`;
      calls.push({ call, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (call === TRANSFER) {
        if (opts.notOwner || (opts.secondTransferRefused && admin)) {
          return refuse(403, 'only the owner can transfer this group');
        }
        return admin && !opts.conflict ? new Response(JSON.stringify({ data: {} }), { status: 200 }) : refuse(409, 'the new owner is not an admin');
      }
      if (call === PROMOTE) {
        if (opts.roleRefused) return refuse(403, 'not allowed');
        admin = true;
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    return calls;
  }

  it('hands the namespace straight to an admin', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode({ admin: true });

    expect(await transferNamespaceOwnership(meroJs, NS, BOB)).toEqual({ promoted: false });
    expect(calls).toEqual([{ call: TRANSFER, body: { newOwner: BOB } }]);
  });

  it('makes a plain member an admin when the node says they are not one, then transfers', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode();

    expect(await transferNamespaceOwnership(meroJs, NS, BOB)).toEqual({ promoted: true });
    expect(calls).toEqual([
      { call: TRANSFER, body: { newOwner: BOB } },
      { call: PROMOTE, body: { role: 'Admin' } },
      { call: TRANSFER, body: { newOwner: BOB } },
    ]);
  });

  it('does not promote a target who is already an admin, whatever the 409 says', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode({ admin: true, conflict: true });

    const result = await transferNamespaceOwnership(meroJs, NS, BOB, true);

    expect(result).toEqual({ promoted: false, error: expect.stringContaining('not an admin') });
    expect(calls.map((c) => c.call)).toEqual([TRANSFER]);
  });

  it('changes nothing when the caller is not the owner', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode({ notOwner: true });

    const result = await transferNamespaceOwnership(meroJs, NS, BOB);

    expect(result.promoted).toBe(false);
    expect(result.error).toContain('only the owner can transfer this group');
    expect(calls.map((c) => c.call)).toEqual([TRANSFER]);
  });

  it('stops when the promotion is refused, without a second transfer', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode({ roleRefused: true });

    const result = await transferNamespaceOwnership(meroJs, NS, BOB);

    expect(result.promoted).toBe(false);
    expect(result.error).toContain('not allowed');
    expect(calls.map((c) => c.call)).toEqual([TRANSFER, PROMOTE]);
  });

  it('reports a refused second transfer, and that the member was promoted', async () => {
    const { meroJs } = await createClientAsync({ baseUrl: 'http://node' });
    const calls = fakeNode({ secondTransferRefused: true });

    const result = await transferNamespaceOwnership(meroJs, NS, BOB);

    expect(result.promoted).toBe(true);
    expect(result.error).toContain('only the owner can transfer this group');
    expect(calls.map((c) => c.call)).toEqual([TRANSFER, PROMOTE, TRANSFER]);
  });
});
