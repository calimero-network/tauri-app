import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let settings: Record<string, unknown>;
vi.mock('../utils/settings', () => ({
  getSettings: () => settings,
}));

const brokerAccessToken = vi.fn();
vi.mock('./token-broker', () => ({
  brokerAccessToken: () => brokerAccessToken(),
}));

// A real MeroJs behind the app's singleton, so these tests still assert what
// reaches the wire: the SDK's own routes, bodies and bearer header.
vi.mock('./mero-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mero-client')>();
  const { MeroJs, MemoryTokenStore } = await import('@calimero-network/mero-js');
  const meroJs = new MeroJs({
    baseUrl: 'http://localhost:2528',
    tokenStore: new MemoryTokenStore(),
  });
  meroJs.setTokenData({
    access_token: 'desktop-access-token',
    refresh_token: 'desktop-refresh-token',
    expires_at: Date.now() + 3_600_000,
  });
  // Only the singleton is stood in for; the error-message helpers are the real
  // ones, since the copy they produce is what these tests assert.
  return { ...actual, apiClient: { meroJs } };
});

// Imported once, unlike agent-connect's suite: device-link.ts keeps no module state.
import {
  listAccountApplications,
  listAccountDevices,
  listNamespaces,
  normalizeConfirmationCode,
  pairComplete,
  pairInit,
  refusalStatus,
  relinkDevice,
  revokeDevice,
  validatePairPayload,
} from './device-link';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch;

function installFetch(
  handler: Response | ((call: FetchCall) => Response | Promise<Response>),
): void {
  calls = [];
  // @ts-expect-error - test double, not the full DOM fetch signature
  globalThis.fetch = (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(typeof handler === 'function' ? handler(call) : handler);
  };
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const HEX_64 = 'a'.repeat(64);
const HEX_128 = 'b'.repeat(128);

/** A pair-init result as the other device would read it out. */
function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: HEX_64,
    kemPublicKey: 'c'.repeat(64),
    signPublicKey: 'd'.repeat(64),
    statement: HEX_128,
    confirmationCode: '7BC0-DAAC-CCB4-84A4',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settings = { nodeUrl: 'http://localhost:2528/' };
  originalFetch = globalThis.fetch;
  brokerAccessToken.mockResolvedValue('desktop-access-token');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('normalizeConfirmationCode', () => {
  it('groups a bare run into fours', () => {
    expect(normalizeConfirmationCode('7BC0DAACCCB484A4')).toBe('7BC0-DAAC-CCB4-84A4');
  });

  it('uppercases a lowercase paste', () => {
    expect(normalizeConfirmationCode('7bc0daacccb484a4')).toBe('7BC0-DAAC-CCB4-84A4');
  });

  it('leaves an already-dashed code as it is', () => {
    expect(normalizeConfirmationCode('7BC0-DAAC-CCB4-84A4')).toBe('7BC0-DAAC-CCB4-84A4');
  });

  it('drops spaces, wherever they fall', () => {
    expect(normalizeConfirmationCode(' 7bc0 daac  ccb4 84a4 ')).toBe('7BC0-DAAC-CCB4-84A4');
  });

  it('drops any other separator a reader might type', () => {
    expect(normalizeConfirmationCode('7bc0:daac.ccb4_84a4')).toBe('7BC0-DAAC-CCB4-84A4');
  });

  it('returns empty for empty input', () => {
    expect(normalizeConfirmationCode('')).toBe('');
  });

  it('returns empty when nothing hex survives the strip', () => {
    // Not just punctuation: letters past F are not code characters either.
    expect(normalizeConfirmationCode('---')).toBe('');
    expect(normalizeConfirmationCode('zzzz-hijk')).toBe('');
  });

  it('keeps a trailing partial group rather than padding or dropping it', () => {
    expect(normalizeConfirmationCode('7bc0da')).toBe('7BC0-DA');
  });

  it('regroups a code whose dashes are in the wrong places', () => {
    expect(normalizeConfirmationCode('7B-C0DA-ACCCB484A4')).toBe('7BC0-DAAC-CCB4-84A4');
  });
});

describe('validatePairPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validatePairPayload(validPayload())).toBeNull();
  });

  it('accepts a confirmation code the reader typed loosely', () => {
    expect(validatePairPayload(validPayload({ confirmationCode: '7bc0 daac ccb4 84a4' }))).toBeNull();
  });

  for (const field of ['deviceId', 'kemPublicKey', 'signPublicKey'] as const) {
    describe(field, () => {
      it('is rejected when absent', () => {
        expect(validatePairPayload(validPayload({ [field]: undefined }))).toBe(
          `${field} must be 64 hex characters`,
        );
      });

      it('is rejected when the paste was truncated', () => {
        expect(validatePairPayload(validPayload({ [field]: 'a'.repeat(63) }))).toBe(
          `${field} must be 64 hex characters`,
        );
      });

      it('is rejected when a character too long', () => {
        expect(validatePairPayload(validPayload({ [field]: 'a'.repeat(65) }))).toBe(
          `${field} must be 64 hex characters`,
        );
      });

      it('is rejected when the right width but not hex', () => {
        // The width alone passing is exactly the case a length check would miss.
        expect(validatePairPayload(validPayload({ [field]: `${'a'.repeat(63)}z` }))).toBe(
          `${field} must be 64 hex characters`,
        );
      });

      it('is rejected when empty', () => {
        expect(validatePairPayload(validPayload({ [field]: '' }))).toBe(
          `${field} must be 64 hex characters`,
        );
      });
    });
  }

  it('accepts uppercase hex, which is the same key', () => {
    expect(validatePairPayload(validPayload({ deviceId: 'A'.repeat(64) }))).toBeNull();
  });

  it('rejects a statement of the wrong width', () => {
    expect(validatePairPayload(validPayload({ statement: 'b'.repeat(127) }))).toBe(
      'statement must be 128 hex characters',
    );
    expect(validatePairPayload(validPayload({ statement: 'b'.repeat(129) }))).toBe(
      'statement must be 128 hex characters',
    );
  });

  it('rejects a statement that is a key rather than a signature', () => {
    // 64 hex is the width of the fields around it, so this is the likely mis-paste.
    expect(validatePairPayload(validPayload({ statement: HEX_64 }))).toBe(
      'statement must be 128 hex characters',
    );
  });

  it('rejects a statement of the right width that is not hex', () => {
    expect(validatePairPayload(validPayload({ statement: `${'b'.repeat(127)}z` }))).toBe(
      'statement must be 128 hex characters',
    );
  });

  it('rejects an absent statement', () => {
    expect(validatePairPayload(validPayload({ statement: undefined }))).toBe(
      'statement must be 128 hex characters',
    );
  });

  it('rejects an empty confirmation code', () => {
    expect(validatePairPayload(validPayload({ confirmationCode: '' }))).toBe(
      'confirmationCode must not be empty',
    );
  });

  it('rejects an absent confirmation code', () => {
    expect(validatePairPayload(validPayload({ confirmationCode: undefined }))).toBe(
      'confirmationCode must not be empty',
    );
  });

  it('rejects a confirmation code with no code characters in it', () => {
    // Normalizing is what makes "----" empty; a raw non-empty check would pass it.
    expect(validatePairPayload(validPayload({ confirmationCode: '----' }))).toBe(
      'confirmationCode must not be empty',
    );
  });

  it('names the first bad field, not the last', () => {
    expect(validatePairPayload({})).toBe('deviceId must be 64 hex characters');
  });
});

describe('listNamespaces', () => {
  it('unwraps the `{ data }` envelope', async () => {
    installFetch(json({ data: [{ namespaceId: 'ns-1', name: 'Drive' }] }));

    await expect(listNamespaces()).resolves.toEqual([{ namespaceId: 'ns-1', name: 'Drive' }]);
    // Core defaults to 100, and a truncated list would silently narrow an invite.
    expect(calls[0].url).toBe('http://localhost:2528/admin-api/namespaces?limit=1000');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer desktop-access-token',
    );
  });

  it('accepts an unwrapped array', async () => {
    installFetch(json([{ namespaceId: 'ns-1' }]));

    await expect(listNamespaces()).resolves.toEqual([{ namespaceId: 'ns-1' }]);
  });

  it('returns nothing rather than throwing when the body is not a list', async () => {
    installFetch(json({ data: null }));

    await expect(listNamespaces()).resolves.toEqual([]);
  });
});

describe('listAccountDevices', () => {
  it('reads the top-level `devices`, which this route sends with no `data` wrapper', async () => {
    const device = {
      deviceId: HEX_64,
      signingKey: 'bs58key',
      isSelf: false,
      revoked: false,
      applications: ['App1'],
      namespaces: ['ns-1'],
    };
    installFetch(json({ devices: [device] }));

    await expect(listAccountDevices()).resolves.toEqual([device]);
    expect(calls[0].url).toBe('http://localhost:2528/admin-api/account/devices');
  });

  it('returns nothing rather than throwing when the body names no devices', async () => {
    installFetch(json({}));

    await expect(listAccountDevices()).resolves.toEqual([]);
  });
});

describe('listAccountApplications', () => {
  it('reads the top-level `applications`', async () => {
    installFetch(json({ applications: [{ applicationId: 'App1', namespaces: ['ns-1'] }] }));

    await expect(listAccountApplications()).resolves.toEqual([
      { applicationId: 'App1', namespaces: ['ns-1'] },
    ]);
    expect(calls[0].url).toBe('http://localhost:2528/admin-api/account/applications');
  });

  it('returns nothing rather than throwing when the body names no applications', async () => {
    installFetch(json({}));

    await expect(listAccountApplications()).resolves.toEqual([]);
  });
});

describe('pairInit', () => {
  it('posts the account root key and every namespace the device is to listen on', async () => {
    const data = validPayload({ accountId: 'e'.repeat(64) });
    installFetch(json({ data }));

    await expect(pairInit(HEX_64, ['ns-1', 'ns-2'])).resolves.toEqual(data);
    expect(calls[0].url).toBe('http://localhost:2528/admin-api/account/pair-init');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      accountRootPublicKey: HEX_64,
      namespaces: ['ns-1', 'ns-2'],
    });
  });

  // The message is compared whole, not by substring: a substring match passes
  // against the SDK's own `HTTP 400 : ...`, which is the copy this must not
  // regress to. `status` rides along because `refusalStatus` reads it.
  it('surfaces the node error message, with no status line in front of it', async () => {
    installFetch(json({ error: 'no account root on this node' }, { status: 400 }));

    await expect(pairInit(HEX_64, ['ns-1'])).rejects.toMatchObject({
      message: 'no account root on this node',
      status: 400,
    });
  });

  it('reports a revoked token family as terminal, in words a user can act on', async () => {
    installFetch(new Response('{}', { status: 401, headers: { 'x-auth-error': 'token_reuse' } }));

    await expect(pairInit(HEX_64, ['ns-1'])).rejects.toThrow(
      'Your node session was revoked. Sign in again, then try again.',
    );
  });

  it('falls back to the status when the body carries no message', async () => {
    installFetch(new Response('', { status: 503 }));

    await expect(pairInit(HEX_64, ['ns-1'])).rejects.toThrow('HTTP 503');
  });

  it('quotes a plain-text refusal verbatim, which the sdk message drops', async () => {
    installFetch(new Response('this node takes part in none of those namespaces', { status: 409 }));

    await expect(pairInit(HEX_64, ['ns-1'])).rejects.toMatchObject({
      message: 'this node takes part in none of those namespaces',
      status: 409,
    });
  });
});

describe('pairComplete', () => {
  it('posts the payload verbatim, normalizing nothing', async () => {
    const payload = validPayload({ confirmationCode: '7bc0 daac ccb4 84a4' });
    installFetch(json({ data: { ...payload, accountId: 'e'.repeat(64), keyDelivered: true } }));

    const result = await pairComplete(payload);

    expect(result.keyDelivered).toBe(true);
    expect(calls[0].url).toBe('http://localhost:2528/admin-api/account/pair-complete');
    // Core ignores grouping and case; rewriting the operator's input here would
    // only hide which of the two sides they actually read out.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(payload);
  });

  it('leaves `applications` off the wire entirely for an unscoped pairing', async () => {
    installFetch(json({ data: {} }));

    await pairComplete(validPayload());

    // Core reads absent as "every application", so the key must not appear as
    // `null` either - only its absence carries the meaning.
    expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty('applications');
  });

  it('names the chosen applications when the pairing was narrowed', async () => {
    installFetch(json({ data: {} }));

    await pairComplete(validPayload(), ['App1', 'App2']);

    expect(JSON.parse(String(calls[0].init?.body)).applications).toEqual(['App1', 'App2']);
  });

  it('refuses a malformed payload without reaching the node', async () => {
    installFetch(json({ data: {} }));

    await expect(pairComplete(validPayload({ deviceId: 'a'.repeat(63) }))).rejects.toThrow(
      'deviceId must be 64 hex characters',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('relinkDevice', () => {
  it('reduces both outcome lists to the namespaces they name', async () => {
    installFetch(
      json({
        data: {
          accountId: 'e'.repeat(64),
          deviceId: HEX_64,
          applications: [],
          linkedIn: [{ namespaceId: 'ns-1', keyDelivered: true }],
          skipped: [
            { namespaceId: 'ns-2', reason: 'alreadyBound' },
            { namespaceId: 'ns-3', reason: 'outOfScope' },
          ],
        },
      }),
    );

    await expect(relinkDevice(HEX_64)).resolves.toEqual({
      linkedIn: ['ns-1'],
      skipped: ['ns-2', 'ns-3'],
    });
    expect(calls[0].url).toBe(
      `http://localhost:2528/admin-api/account/devices/${HEX_64}/relink`,
    );
    expect(calls[0].init?.method).toBe('POST');
  });

  it('sends no applications when repairing drift, which is core\'s "change nothing"', async () => {
    installFetch(json({ data: {} }));

    await relinkDevice(HEX_64);

    expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty('applications');
  });

  it('sends the applications when widening the scope', async () => {
    installFetch(json({ data: {} }));

    await relinkDevice(HEX_64, ['App1']);

    expect(JSON.parse(String(calls[0].init?.body)).applications).toEqual(['App1']);
  });

  it('reports nothing rather than throwing when the node names no outcomes', async () => {
    installFetch(json({ data: { accountId: 'e'.repeat(64), deviceId: HEX_64 } }));

    await expect(relinkDevice(HEX_64)).resolves.toEqual({ linkedIn: [], skipped: [] });
  });
});

describe('revokeDevice', () => {
  it('reduces the outcome entries to the namespaces the device lost', async () => {
    installFetch(
      json({
        data: {
          accountId: 'e'.repeat(64),
          deviceId: HEX_64,
          keyRotated: true,
          revokedIn: [
            { namespaceId: 'ns-1', keyRotated: true },
            { namespaceId: 'ns-2', keyRotated: false },
          ],
        },
      }),
    );

    await expect(revokeDevice('ns-1', HEX_64)).resolves.toEqual({ revokedIn: ['ns-1', 'ns-2'] });
    expect(calls[0].url).toBe('http://localhost:2528/admin-api/namespaces/ns-1/account/revoke');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ deviceId: HEX_64 });
  });

  it('reports no namespaces rather than throwing when the node names none', async () => {
    installFetch(json({ data: { accountId: 'e'.repeat(64), deviceId: HEX_64 } }));

    await expect(revokeDevice('ns-1', HEX_64)).resolves.toEqual({ revokedIn: [] });
  });
});

describe('refusalStatus', () => {
  it('carries the status core refused with, so a caller can tell one refusal from another', async () => {
    installFetch(
      json({ error: { message: 'this node takes part in none of those namespaces' } }, { status: 409 }),
    );
    const err = await pairComplete(validPayload(), ['App1']).catch((e: unknown) => e);
    expect(refusalStatus(err)).toBe(409);
    expect((err as Error).message).toContain('takes part in none');
  });

  it('distinguishes a bad payload from an unreachable scope', async () => {
    installFetch(json({ error: { message: 'confirmation code does not match' } }, { status: 400 }));
    const err = await pairComplete(validPayload(), undefined).catch((e: unknown) => e);
    expect(refusalStatus(err)).toBe(400);
  });

  it('is undefined for anything that is not a refusal from the node', () => {
    expect(refusalStatus(new Error('the network went away'))).toBeUndefined();
    expect(refusalStatus(undefined)).toBeUndefined();
    expect(refusalStatus('not an error at all')).toBeUndefined();
  });
});

describe('listAccountApplications on a device that syncs no namespace metadata', () => {
  it('drops the all-zero placeholder a non-member is served, rather than offering it as an app', async () => {
    installFetch(
      json({
        applications: [
          { applicationId: '0'.repeat(64), namespaces: [HEX_64] },
          { applicationId: 'ca'.repeat(32), namespaces: [HEX_64] },
        ],
      }),
    );
    const apps = await listAccountApplications();
    expect(apps.map((a) => a.applicationId)).toEqual(['ca'.repeat(32)]);
  });
});
