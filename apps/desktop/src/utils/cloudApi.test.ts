import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The token-storage module reads from window.localStorage on import;
// mock it before the SUT is required so getAccessToken() returns a
// predictable value across tests.
vi.mock('../lib/token-storage', () => ({
  getAccessToken: () => 'test-access-token',
  getRefreshToken: () => null,
}));

// settings.ts touches localStorage too — keep it inert.
vi.mock('./settings', () => ({
  getSettings: () => ({ nodeUrl: 'http://localhost:2528' }),
  saveSettings: () => {},
}));

import {
  requestOwnershipProof,
  claimContexts,
  enableHaForNamespace,
  CLOUD_BASE_URL,
} from './cloudApi';

// Minimal JWT shaped for parseJwtPayload — only need the payload
// segment to decode; signature is ignored.
function makeJwt(payload: object): string {
  const b64 = (s: string) =>
    btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // Default to a live (1h) exp so callers that only care about iss/email
  // still pass enableHaForNamespace's isTokenExpired guard; an explicit
  // `exp` in `payload` overrides this (spread order).
  const body = b64(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }),
  );
  return `${header}.${body}.sig`;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function installFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  // @ts-expect-error — test double, not the full DOM fetch signature
  globalThis.fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('requestOwnershipProof', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('POSTs camelCase body to merod and re-keys camelCase response to snake_case', async () => {
    const { calls, restore: r } = installFetch(() =>
      jsonResponse({
        signerPublicKey: 'pk-base58',
        signedPayload: 'sp-b64',
        signature: 'sig-b64',
      }),
    );
    restore = r;

    const out = await requestOwnershipProof('http://node', 'group-1', {
      contextId: 'ctx-1',
      subject: 'user@example.com',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'http://node/admin-api/groups/group-1/issue-ownership-proof',
    );
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.audience).toBe('mdma:claim-context');
    expect(body.contextId).toBe('ctx-1');
    expect(body.subject).toBe('user@example.com');
    expect(typeof body.nonce).toBe('string');
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof body.expiresAtMs).toBe('number');

    expect(out).toEqual({
      signer_public_key: 'pk-base58',
      signed_payload: 'sp-b64',
      signature: 'sig-b64',
    });
  });

  it('throws when the merod response is malformed', async () => {
    const { restore: r } = installFetch(() => jsonResponse({}));
    restore = r;
    await expect(
      requestOwnershipProof('http://node', 'group-1', {
        contextId: 'ctx',
        subject: 'u@e',
      }),
    ).rejects.toThrow(/Malformed ownership proof/);
  });

  it('throws with body text when merod returns non-ok', async () => {
    const { restore: r } = installFetch(
      () => new Response('group not found', { status: 404 }),
    );
    restore = r;
    await expect(
      requestOwnershipProof('http://node', 'group-1', {
        contextId: 'ctx',
        subject: 'u@e',
      }),
    ).rejects.toThrow(/group not found/);
  });
});

describe('claimContexts', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('POSTs the snake_case wire payload to the cloud and returns claimed[]', async () => {
    const { calls, restore: r } = installFetch(() =>
      jsonResponse({ claimed: ['ctx-1'] }),
    );
    restore = r;
    const sessionJwt = makeJwt({ iss: 'mdma' });
    const claimed = await claimContexts(sessionJwt, [
      {
        context_id: 'ctx-1',
        ownership_proof: {
          signer_public_key: 'pk',
          signed_payload: 'sp',
          signature: 'sig',
        },
      },
    ]);
    expect(claimed).toEqual(['ctx-1']);
    expect(calls[0].url).toBe(`${CLOUD_BASE_URL}/api/cloud/me/contexts/claim`);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({
      claims: [
        {
          context_id: 'ctx-1',
          ownership_proof: {
            signer_public_key: 'pk',
            signed_payload: 'sp',
            signature: 'sig',
          },
        },
      ],
    });
  });

  it('surfaces the detail string on 403', async () => {
    const { restore: r } = installFetch(() =>
      jsonResponse(
        { detail: 'Ownership proof failed: signer not registered' },
        403,
      ),
    );
    restore = r;
    await expect(
      claimContexts(makeJwt({ iss: 'mdma' }), []),
    ).rejects.toThrow(/Ownership proof failed: signer not registered/);
  });
});

describe('enableHaForNamespace silent-claim pre-flight', () => {
  let restore: () => void;
  beforeEach(() => {
    // Deterministic but *distinct per call* — a counter advances each
    // fill so parallel proof requests get different nonces (a constant
    // mock would mask a per-batch duplicate-nonce regression).
    let counter = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr: any) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (counter + i) & 0xff;
      counter += arr.length;
      return arr;
    });
  });
  afterEach(() => {
    restore?.();
    vi.restoreAllMocks();
  });

  function route(
    url: string,
    init: RequestInit | undefined,
    handlers: Record<string, () => Response>,
  ): Response {
    for (const [pattern, h] of Object.entries(handlers)) {
      if (url.includes(pattern)) return h();
    }
    return new Response(`unmatched: ${url} ${init?.method ?? 'GET'}`, {
      status: 500,
    });
  }

  it('fails closed when the caller is not the namespace admin', async () => {
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'me', role: 'Member' }],
            selfIdentity: 'me',
          }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', [
        { group_id: 'g1', context_id: 'ctx-1' },
      ]),
    ).rejects.toThrow(/Only the namespace admin can register contexts/);
  });

  it('gives a distinct error when our identity is not among the members', async () => {
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'someone-else', role: 'Admin' }],
            selfIdentity: 'me',
          }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', [
        { group_id: 'g1', context_id: 'ctx-1' },
      ]),
    ).rejects.toThrow(/Could not determine your role in this namespace/);
  });

  it('throws (not silent-null → misleading not-admin) on a malformed members body', async () => {
    // Regression guard for the {data}-envelope bug: a wrong-shaped 200
    // must surface as a shape error, not masquerade as "not admin".
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            data: { data: [{ identity: 'me', role: 'Admin' }], selfIdentity: 'me' },
          }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', [
        { group_id: 'g1', context_id: 'ctx-1' },
      ]),
    ).rejects.toThrow(/Unexpected response from local node members endpoint/);
  });

  it('runs members → proofs (parallel) → claim → measurements → tee-policy → enable in order', async () => {
    const calls: string[] = [];
    const { restore: r } = installFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'me', role: 'Admin' }],
            selfIdentity: 'me',
          }),
        '/admin-api/groups/ns-root/issue-ownership-proof': () =>
          jsonResponse({
            signerPublicKey: 'pk',
            signedPayload: 'sp',
            signature: 'sig',
          }),
        '/api/cloud/me/contexts/claim': () =>
          jsonResponse({ claimed: ['ctx-1', 'ctx-2'] }),
        '/api/cloud/fleet/measurements': () =>
          jsonResponse({
            release_tag: 'v1',
            allowed_mrtd: ['mrtd-1'],
            allowed_rtmr0: [],
            allowed_rtmr1: [],
            allowed_rtmr2: [],
            allowed_rtmr3: [],
          }),
        '/admin-api/groups/ns-root/settings/tee-admission-policy': () =>
          new Response('{}', { status: 200 }),
        '/api/cloud/me/namespaces/ns-root/enable-ha': () =>
          jsonResponse({
            status: 'enabling',
            namespace_id: 'ns-root',
            groups: [],
          }),
      });
    });
    restore = r;

    const res = await enableHaForNamespace(
      makeJwt({ iss: 'mdma', email: 'u@e' }),
      'http://node',
      'ns-root',
      [
        { group_id: 'ns-root', context_id: 'ctx-1' },
        { group_id: 'sub-1', context_id: 'ctx-2' },
      ],
    );
    expect(res.status).toBe('enabling');

    // Order: members must come before any proof; proofs must come
    // before the claim POST; claim must precede measurements; tee-
    // policy must precede the final enable.
    const ordered = (substr: string) =>
      calls.findIndex((c) => c.includes(substr));
    expect(ordered('/members')).toBeLessThan(ordered('/issue-ownership-proof'));
    expect(ordered('/issue-ownership-proof')).toBeLessThan(
      ordered('/contexts/claim'),
    );
    expect(ordered('/contexts/claim')).toBeLessThan(
      ordered('/fleet/measurements'),
    );
    expect(ordered('/fleet/measurements')).toBeLessThan(
      ordered('/tee-admission-policy'),
    );
    expect(ordered('/tee-admission-policy')).toBeLessThan(
      ordered('/enable-ha'),
    );

    // Exactly two proof requests (one per group) — parallel, but both
    // present in the call list.
    const proofCalls = calls.filter((c) =>
      c.includes('/issue-ownership-proof'),
    );
    expect(proofCalls).toHaveLength(2);

    // *Every* proof call must precede the claim — findIndex only checks
    // the first, so a bug where one proof lands after the claim would
    // otherwise slip through.
    const claimIdx = calls.findIndex((c) => c.includes('/contexts/claim'));
    for (const pc of proofCalls) {
      expect(calls.indexOf(pc)).toBeLessThan(claimIdx);
    }
  });

  it('throws a clear error when the MDMA session JWT lacks an identifier', async () => {
    const { restore: r } = installFetch(() => jsonResponse({}));
    restore = r;
    await expect(
      enableHaForNamespace(
        makeJwt({ iss: 'mdma' }), // no email, no sub
        'http://node',
        'ns-root',
        [{ group_id: 'g', context_id: 'c' }],
      ),
    ).rejects.toThrow(/missing the user identifier/);
  });

  it('issues a distinct nonce per parallel proof request', async () => {
    const bodies: any[] = [];
    const { restore: r } = installFetch((url, init) => {
      if (url.includes('/issue-ownership-proof')) {
        bodies.push(JSON.parse(String(init?.body)));
      }
      return route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'me', role: 'Admin' }],
            selfIdentity: 'me',
          }),
        '/admin-api/groups/ns-root/issue-ownership-proof': () =>
          jsonResponse({
            signerPublicKey: 'pk',
            signedPayload: 'sp',
            signature: 'sig',
          }),
        '/api/cloud/me/contexts/claim': () =>
          jsonResponse({ claimed: ['ctx-1', 'ctx-2'] }),
        '/api/cloud/fleet/measurements': () =>
          jsonResponse({
            release_tag: 'v1',
            allowed_mrtd: ['mrtd-1'],
            allowed_rtmr0: [],
            allowed_rtmr1: [],
            allowed_rtmr2: [],
            allowed_rtmr3: [],
          }),
        '/admin-api/groups/ns-root/settings/tee-admission-policy': () =>
          new Response('{}', { status: 200 }),
        '/api/cloud/me/namespaces/ns-root/enable-ha': () =>
          jsonResponse({ status: 'enabling', namespace_id: 'ns-root', groups: [] }),
      });
    });
    restore = r;
    await enableHaForNamespace(
      makeJwt({ iss: 'mdma', email: 'u@e' }),
      'http://node',
      'ns-root',
      [
        { group_id: 'ns-root', context_id: 'ctx-1' },
        { group_id: 'sub-1', context_id: 'ctx-2' },
      ],
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0].nonce).not.toBe(bodies[1].nonce);
    for (const b of bodies) expect(b.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a non-MDMA or expired session token before any network call', async () => {
    const { calls, restore: r } = installFetch(() => jsonResponse({}));
    restore = r;
    // iss != "mdma"
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'google', email: 'u@e' }), 'http://node', 'ns', [
        { group_id: 'g', context_id: 'c' },
      ]),
    ).rejects.toThrow(/Not signed in to Calimero Cloud/);
    // mdma but expired
    await expect(
      enableHaForNamespace(
        makeJwt({ iss: 'mdma', email: 'u@e', exp: Math.floor(Date.now() / 1000) - 10 }),
        'http://node',
        'ns',
        [{ group_id: 'g', context_id: 'c' }],
      ),
    ).rejects.toThrow(/Cloud session has expired/);
    expect(calls).toHaveLength(0); // failed fast, no merod/cloud round-trips
  });

  it('throws (and does not enable HA) when the cloud only partially claims', async () => {
    const seen: string[] = [];
    const { restore: r } = installFetch((url, init) => {
      seen.push(url);
      return route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'me', role: 'Admin' }],
            selfIdentity: 'me',
          }),
        '/admin-api/groups/ns-root/issue-ownership-proof': () =>
          jsonResponse({ signerPublicKey: 'pk', signedPayload: 'sp', signature: 'sig' }),
        // Submitted ctx-1 + ctx-2, cloud only claims ctx-1.
        '/api/cloud/me/contexts/claim': () => jsonResponse({ claimed: ['ctx-1'] }),
      });
    });
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', [
        { group_id: 'ns-root', context_id: 'ctx-1' },
        { group_id: 'sub-1', context_id: 'ctx-2' },
      ]),
    ).rejects.toThrow(/did not register 1 of 2 context\(s\): ctx-2/);
    // Must have stopped before the enable-ha / tee-policy steps.
    expect(seen.some((u) => u.includes('/enable-ha'))).toBe(false);
    expect(seen.some((u) => u.includes('/tee-admission-policy'))).toBe(false);
  });

  it('throws a descriptive error (not a raw TypeError) on a malformed member entry', async () => {
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({ members: [null], selfIdentity: 'me' }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', [
        { group_id: 'g1', context_id: 'ctx-1' },
      ]),
    ).rejects.toThrow(/Unexpected response from local node members endpoint/);
  });
});
