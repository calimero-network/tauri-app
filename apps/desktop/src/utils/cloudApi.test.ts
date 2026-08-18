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
  enableHaForNamespace,
  getCloudNamespaces,
  ensureTeeAdmissionPolicy,
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

describe('getCloudNamespaces', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('GETs the namespace-native read model with a bearer token', async () => {
    const rows = [
      {
        namespace_id: 'ns-1',
        contexts: ['ctx-1'],
        ha_status: 'enabled',
        ha_enabled_at: '2026-01-01T00:00:00Z',
        fleet_replicas: { active: 1, assigned: 1, limit: 3 },
      },
    ];
    const { calls, restore: r } = installFetch(() => jsonResponse(rows));
    restore = r;

    const out = await getCloudNamespaces(makeJwt({ iss: 'mdma' }));

    expect(calls).toHaveLength(1);
    // Migrated off the deprecated /api/cloud/me/groups alias.
    expect(calls[0].url).toBe(`${CLOUD_BASE_URL}/api/cloud/me/namespaces`);
    expect(calls[0].init?.method ?? 'GET').toBe('GET');
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toMatch(/^Bearer /);
    expect(out).toEqual(rows);
  });

  it('returns [] on a non-ok response instead of throwing', async () => {
    const { restore: r } = installFetch(() => jsonResponse({}, 500));
    restore = r;
    await expect(getCloudNamespaces(makeJwt({ iss: 'mdma' }))).resolves.toEqual(
      [],
    );
  });
});

describe('enableHaForNamespace', () => {
  let restore: () => void;
  beforeEach(() => {
    // Deterministic but *distinct per call* — a counter advances each
    // fill so the namespace-proof nonce is well-formed and a future
    // multi-proof regression would still surface.
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
    // `getSelfRoleInGroup` asks the node who it is, because rc.23 removed
    // `selfIdentity` from the member listing (#3522). Defaulted here so each
    // test keeps stating only the thing it is about; a test that cares about
    // the identity lookup overrides it.
    const withDefaults: Record<string, () => Response> = {
      '/admin-api/identity': () => jsonResponse({ accountId: 'me' }),
      ...handlers,
    };
    for (const [pattern, h] of Object.entries(withDefaults)) {
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
          }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', []),
    ).rejects.toThrow(/Only the namespace admin can enable HA/);
  });

  it('gives a distinct error when our identity is not among the members', async () => {
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'someone-else', role: 'Admin' }],
          }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', []),
    ).rejects.toThrow(/Could not determine your role in this namespace/);
  });

  it('throws (not silent-null → misleading not-admin) on a malformed members body', async () => {
    // Regression guard for the {data}-envelope bug: a wrong-shaped 200
    // must surface as a shape error, not masquerade as "not admin".
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            data: { data: [{ identity: 'me', role: 'Admin' }] },
          }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', []),
    ).rejects.toThrow(/Unexpected response from local node members endpoint/);
  });

  it('real-context path is rejected fail-fast with no network calls (mdma#162)', async () => {
    // Passing a non-empty context_id would route to the cloud's enable-ha
    // real-context branch, which authorises against the never-populated
    // `UserContext` ledger and 404s. The client rejects it up front —
    // before any merod/cloud round-trip — rather than dispatching to the
    // broken server path.
    const calls: string[] = [];
    const { restore: r } = installFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return jsonResponse({});
    });
    restore = r;

    await expect(
      enableHaForNamespace(
        makeJwt({ iss: 'mdma', email: 'u@e' }),
        'http://node',
        'ns-root',
        [
          { group_id: 'ns-root', context_id: 'ctx-1' },
          { group_id: 'sub-1', context_id: 'ctx-2' },
        ],
      ),
    ).rejects.toThrow(/Per-context HA registration is disabled.*mdma#162/);

    // Fail-fast: nothing was dispatched to merod or the cloud.
    expect(calls).toHaveLength(0);
  });

  it('no-context path ([] groups): members → measurements → tee-policy → ONE namespace proof → enable', async () => {
    const calls: string[] = [];
    let enableBody: any;
    const { restore: r } = installFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/enable-ha')) {
        enableBody = JSON.parse(String(init?.body));
      }
      return route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'me', role: 'Admin' }],
          }),
        '/admin-api/groups/ns-root/issue-namespace-ownership-proof': () =>
          jsonResponse({
            signerPublicKey: 'pk',
            signedPayload: 'sp',
            signature: 'sig',
          }),
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
      [], // zero-context namespace
    );
    expect(res.status).toBe('enabling');

    // Exactly one namespace-scoped ownership proof, after tee-policy.
    const nsProofCalls = calls.filter((c) =>
      c.includes('/issue-namespace-ownership-proof'),
    );
    expect(nsProofCalls).toHaveLength(1);
    const ordered = (substr: string) =>
      calls.findIndex((c) => c.includes(substr));
    expect(ordered('/tee-admission-policy')).toBeLessThan(
      ordered('/issue-namespace-ownership-proof'),
    );
    expect(ordered('/issue-namespace-ownership-proof')).toBeLessThan(
      ordered('/enable-ha'),
    );

    // The namespace proof is sent as ownership_proof with an empty group
    // list — the authoritative server-verified gate for this path.
    expect(enableBody.groups).toEqual([]);
    expect(enableBody.ownership_proof).toEqual({
      signer_public_key: 'pk',
      signed_payload: 'sp',
      signature: 'sig',
    });
  });

  it('throws a clear error when the MDMA session JWT lacks an identifier', async () => {
    const { restore: r } = installFetch(() => jsonResponse({}));
    restore = r;
    await expect(
      enableHaForNamespace(
        makeJwt({ iss: 'mdma' }), // no email, no sub
        'http://node',
        'ns-root',
        [],
      ),
    ).rejects.toThrow(/missing the user identifier/);
  });

  it('the no-context namespace proof carries a well-formed nonce + the enable-ha audience', async () => {
    let proofBody: any;
    const { restore: r } = installFetch((url, init) => {
      if (url.includes('/issue-namespace-ownership-proof')) {
        proofBody = JSON.parse(String(init?.body));
      }
      return route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({
            members: [{ identity: 'me', role: 'Admin' }],
          }),
        '/admin-api/groups/ns-root/issue-namespace-ownership-proof': () =>
          jsonResponse({
            signerPublicKey: 'pk',
            signedPayload: 'sp',
            signature: 'sig',
          }),
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
      [],
    );
    expect(proofBody).toBeDefined();
    expect(proofBody.audience).toBe('mdma:enable-ha-namespace');
    expect(proofBody.subject).toBe('u@e');
    expect(proofBody.nonce).toMatch(/^[0-9a-f]{32}$/);
    // No contextId on a namespace-scoped proof.
    expect(proofBody.contextId).toBeUndefined();
  });

  it('rejects a non-MDMA or expired session token before any network call', async () => {
    const { calls, restore: r } = installFetch(() => jsonResponse({}));
    restore = r;
    // iss != "mdma"
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'google', email: 'u@e' }), 'http://node', 'ns', []),
    ).rejects.toThrow(/Not signed in to Calimero Cloud/);
    // mdma but expired
    await expect(
      enableHaForNamespace(
        makeJwt({ iss: 'mdma', email: 'u@e', exp: Math.floor(Date.now() / 1000) - 10 }),
        'http://node',
        'ns',
        [],
      ),
    ).rejects.toThrow(/Cloud session has expired/);
    expect(calls).toHaveLength(0); // failed fast, no merod/cloud round-trips
  });

  it('throws the descriptive error (not a raw SyntaxError) on a non-JSON members body', async () => {
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          new Response('<html>502 bad gateway</html>', { status: 200 }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', []),
    ).rejects.toThrow(/Unexpected response from local node members endpoint/);
  });

  it('throws a descriptive error (not a raw TypeError) on a malformed member entry', async () => {
    const { restore: r } = installFetch((url, init) =>
      route(url, init, {
        '/admin-api/groups/ns-root/members': () =>
          jsonResponse({ members: [null] }),
      }),
    );
    restore = r;
    await expect(
      enableHaForNamespace(makeJwt({ iss: 'mdma', email: 'u@e' }), 'http://node', 'ns-root', []),
    ).rejects.toThrow(/Unexpected response from local node members endpoint/);
  });
});

describe('ensureTeeAdmissionPolicy', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  const membersAdmin = () =>
    jsonResponse({ members: [{ identity: 'me', role: 'Admin' }] });
  const membersMember = () =>
    jsonResponse({ members: [{ identity: 'me', role: 'Member' }] });
  const measurements = (mrtd: string[]) =>
    jsonResponse({
      release_tag: 'v1',
      allowed_mrtd: mrtd,
      allowed_rtmr0: [],
      allowed_rtmr1: [],
      allowed_rtmr2: [],
      allowed_rtmr3: [],
    });
  const idToken = () => makeJwt({ iss: 'mdma', email: 'u@e' });

  it('skips (no measurements, no PUT) when the node is not the namespace admin', async () => {
    const calls: string[] = [];
    const { restore: r } = installFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/members')) return membersMember();
      return jsonResponse({});
    });
    restore = r;
    await expect(
      ensureTeeAdmissionPolicy('http://node', idToken(), 'ns-root'),
    ).resolves.toBe('skipped');
    // A member must never fetch measurements or PUT a policy it cannot sign.
    expect(calls.some((c) => c.includes('/fleet/measurements'))).toBe(false);
    expect(calls.some((c) => c.includes('/tee-admission-policy'))).toBe(false);
  });

  it('skips when the node is not a member of the namespace root (role lookup throws)', async () => {
    const { restore: r } = installFetch((url) => {
      if (url.includes('/members')) return new Response('not a member', { status: 404 });
      return jsonResponse({});
    });
    restore = r;
    await expect(
      ensureTeeAdmissionPolicy('http://node', idToken(), 'ns-root'),
    ).resolves.toBe('skipped');
  });

  it('skips when there are no fleet MRTD measurements', async () => {
    const { restore: r } = installFetch((url) => {
      if (url.includes('/members')) return membersAdmin();
      if (url.includes('/fleet/measurements')) return measurements([]);
      return jsonResponse({});
    });
    restore = r;
    await expect(
      ensureTeeAdmissionPolicy('http://node', idToken(), 'ns-root'),
    ).resolves.toBe('skipped');
  });

  it("is a no-op ('ok', no PUT) when the on-node policy already covers the desired MRTDs", async () => {
    const calls: { method: string; url: string }[] = [];
    const { restore: r } = installFetch((url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.includes('/members')) return membersAdmin();
      if (url.includes('/fleet/measurements')) return measurements(['mrtd-1']);
      if (url.includes('/tee-admission-policy'))
        return jsonResponse({ enabled: true, allowedMrtd: ['mrtd-1'] });
      return jsonResponse({});
    });
    restore = r;
    await expect(
      ensureTeeAdmissionPolicy('http://node', idToken(), 'ns-root'),
    ).resolves.toBe('ok');
    expect(
      calls.some((c) => c.method === 'PUT' && c.url.includes('/tee-admission-policy')),
    ).toBe(false);
  });

  it("re-authors ('reasserted') when no policy is set (enabled:false) — the stuck-node case", async () => {
    let putBody: { allowedMrtd?: unknown } | undefined;
    const { restore: r } = installFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/members')) return membersAdmin();
      if (url.includes('/fleet/measurements')) return measurements(['mrtd-1']);
      if (url.includes('/tee-admission-policy')) {
        if (method === 'PUT') {
          putBody = JSON.parse(String(init?.body));
          return new Response('{}', { status: 200 });
        }
        return jsonResponse({ enabled: false, allowedMrtd: [] });
      }
      return jsonResponse({});
    });
    restore = r;
    await expect(
      ensureTeeAdmissionPolicy('http://node', idToken(), 'ns-root'),
    ).resolves.toBe('reasserted');
    // PUT uses the load-bearing camelCase key with the current MRTD set.
    expect(putBody?.allowedMrtd).toEqual(['mrtd-1']);
  });

  it('re-authors when the policy is stale (MRTD rotated — different set)', async () => {
    let putBody: { allowedMrtd?: unknown } | undefined;
    const { restore: r } = installFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/members')) return membersAdmin();
      if (url.includes('/fleet/measurements')) return measurements(['mrtd-NEW']);
      if (url.includes('/tee-admission-policy')) {
        if (method === 'PUT') {
          putBody = JSON.parse(String(init?.body));
          return new Response('{}', { status: 200 });
        }
        return jsonResponse({ enabled: true, allowedMrtd: ['mrtd-OLD'] });
      }
      return jsonResponse({});
    });
    restore = r;
    await expect(
      ensureTeeAdmissionPolicy('http://node', idToken(), 'ns-root'),
    ).resolves.toBe('reasserted');
    expect(putBody?.allowedMrtd).toEqual(['mrtd-NEW']);
  });
});
