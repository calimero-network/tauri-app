import { getSettings } from './settings';
import { getAccessToken } from '../lib/token-storage';

/**
 * Who this node is — `GET /admin-api/identity`.
 *
 * core 0.11.0-rc.23 deleted `GET /admin-api/namespaces/:id/identity` (#3522),
 * which is what `useNamespaceIdentity` (and mero-js 2.x's
 * `getNamespaceIdentity`) calls. The route was a lie with an extra path
 * segment: it took a namespace and answered with the node's account whichever
 * one you passed, because every namespace on a node resolves to the same
 * account. So there is nothing per-namespace to ask for, and asking a
 * namespace only ever made the answer look like it varied by scope.
 *
 * Fetched directly rather than through the SDK because the pinned mero-js
 * (2.2.1) has no `getNodeIdentity` — the same reason the member list next to
 * this is a raw fetch.
 */
export interface NodeIdentity {
  /** The account this node writes as, 64 hex characters. */
  accountId: string;
  /** Hex `DeviceId`, absent on a node that has not enrolled into an account. */
  deviceId?: string;
  /** The key this node signs ops with, base58 — the DEVICE key. */
  publicKey?: string;
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
