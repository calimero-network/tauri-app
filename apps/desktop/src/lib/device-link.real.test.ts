/** Route-mocked tests cannot catch envelope or encoding drift, so this hits a
 *  real node when given one and skips cleanly otherwise:
 *  `REAL_NODE_URL=http://localhost:<port> REAL_NODE_TOKEN=<jwt> pnpm --filter desktop test:unit -- device-link.real`
 */
import { describe, it, expect, vi } from 'vitest';

const REAL_NODE_URL = process.env.REAL_NODE_URL;
const REAL_NODE_TOKEN = process.env.REAL_NODE_TOKEN;
const hasRealNode = Boolean(REAL_NODE_URL && REAL_NODE_TOKEN);

vi.mock('../utils/settings', () => ({
  getSettings: () => ({ nodeUrl: REAL_NODE_URL ?? '' }),
}));
vi.mock('./token-broker', () => ({
  brokerAccessToken: () => Promise.resolve(REAL_NODE_TOKEN ?? ''),
}));
vi.mock('./token-storage', () => ({
  getAccessToken: () => REAL_NODE_TOKEN ?? null,
}));

import {
  listAccountApplications,
  listAccountDevices,
  listNamespaces,
  pairInit,
  validatePairPayload,
} from './device-link';
import { fetchNodeIdentity } from '../utils/nodeIdentity';

const HEX_64 = /^[0-9a-fA-F]{64}$/;

describe.skipIf(!hasRealNode)('device-link against a real node', () => {
  let firstNamespace: string | undefined;
  let accountRootPublicKey: string | undefined;

  it('lists namespaces with hex ids and hex application targets', async () => {
    const namespaces = await listNamespaces();
    expect(Array.isArray(namespaces)).toBe(true);
    for (const ns of namespaces) {
      expect(ns.namespaceId).toMatch(HEX_64);
      expect(ns.targetApplicationId).toMatch(HEX_64);
    }
    firstNamespace = namespaces[0]?.namespaceId;
  });

  it('lists account devices with hex device ids and hex signing keys', async () => {
    const devices = await listAccountDevices();
    expect(Array.isArray(devices)).toBe(true);
    for (const device of devices) {
      expect(device.deviceId).toMatch(HEX_64);
      expect(device.signingKey).toMatch(HEX_64);
      for (const nsId of device.namespaces) expect(nsId).toMatch(HEX_64);
    }
  });

  it('lists account applications with hex ids', async () => {
    const applications = await listAccountApplications();
    expect(Array.isArray(applications)).toBe(true);
    for (const app of applications) {
      expect(app.applicationId).toMatch(HEX_64);
      for (const nsId of app.namespaces) expect(nsId).toMatch(HEX_64);
    }
  });

  it('reads node identity with a 64-hex account root key', async () => {
    const identity = await fetchNodeIdentity();
    if (identity?.accountRootPublicKey) {
      expect(identity.accountRootPublicKey).toMatch(HEX_64);
    }
    accountRootPublicKey = identity?.accountRootPublicKey;
  });

  it('pair-inits an unlinked row with the widths validatePairPayload expects', async () => {
    expect(accountRootPublicKey).toBeDefined();
    expect(firstNamespace).toBeDefined();

    // pair-init is idempotent and only mints an unlinked row, so this is safe
    // to run against real state; pair-complete/relink/revoke are not.
    const result = await pairInit(accountRootPublicKey!, [firstNamespace!]);

    expect(validatePairPayload(result)).toBeNull();
  });
});
