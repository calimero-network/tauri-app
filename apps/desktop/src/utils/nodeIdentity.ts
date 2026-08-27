import { getSettings } from './settings';
import { getAccessToken } from '../lib/token-storage';

/**
 * Who this node is — `GET /admin-api/identity`.
 *
 * core 0.11.0-rc.23 deleted `GET /admin-api/namespaces/:id/identity` (#3522),
 * which is what `useNamespaceIdentity` (and mero-js's `getNamespaceIdentity`)
 * calls. The route was a lie with an extra path segment: it took a namespace
 * and answered with the node's account whichever one you passed, because every
 * namespace on a node resolves to the same account. So there is nothing
 * per-namespace to ask for, and asking a namespace only ever made the answer
 * look like it varied by scope.
 *
 * This is a raw fetch for a reason that NO LONGER HOLDS. It was written when
 * the app pinned mero-js 2.2.1, which had no `getNodeIdentity`; mero-js 13
 * exposes `admin.getNodeIdentity()` returning its own `NodeIdentity`, and
 * likewise `admin.listGroupMembers()` for the member list next to this. Both
 * raw fetches can collapse onto the SDK.
 *
 * Not done in the SDK-bump PR that made it possible: the desktop e2e suite is
 * entirely `page.route`-mocked, so swapping a hand-rolled fetch for an SDK call
 * would be verified only against our own mock bodies. That swap wants one run
 * against a real node, so it is left as a deliberate follow-up rather than
 * ridden along with a version bump.
 */
export interface NodeIdentity {
  /** The account this node writes as, 64 hex characters. */
  accountId: string;
  /** Hex `DeviceId`, absent on a node that has not enrolled into an account. */
  deviceId?: string;
  /** The key this node signs ops with, base58 — the DEVICE key. */
  publicKey?: string;
  /** Epoch-0 account ROOT public key, 64 hex - what a second device pairs into. Absent at or below 0.11.0-rc.22. */
  accountRootPublicKey?: string;
}

/**
 * A miss is a NORMAL state, not an error: the route 404s on a node that has
 * taken part in nothing yet, because it holds neither a device nor an account
 * root. Callers then simply cannot mark anyone as "you".
 */
export async function fetchNodeIdentity(
  signal?: AbortSignal,
): Promise<NodeIdentity | null> {
  const settings = getSettings();
  const token = getAccessToken();
  if (!settings.nodeUrl || !token) return null;

  const res = await fetch(`${settings.nodeUrl}/admin-api/identity`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return null;

  // core's ApiResponse serializes the payload struct directly for some routes
  // and wraps it in `{ data }` for others, so accept both rather than pinning
  // the one this node happens to use.
  const body = (await res.json().catch(() => null)) as
    | { data?: NodeIdentity }
    | NodeIdentity
    | null;
  if (!body) return null;
  const identity = (body as { data?: NodeIdentity }).data ?? (body as NodeIdentity);
  return typeof identity?.accountId === 'string' ? identity : null;
}
