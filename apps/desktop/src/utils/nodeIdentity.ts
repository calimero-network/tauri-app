import { getSettings } from './settings';
import { getAccessToken } from '../lib/token-storage';

/** Who this node is: `GET /admin-api/identity`. */
export interface NodeIdentity {
  /** The account this node writes as, 64 hex characters. */
  accountId: string;
  /** Hex `DeviceId`, absent on a node that has not enrolled into an account. */
  deviceId?: string;
  /** The key this node signs ops with, 64 hex - the DEVICE key, not the root's. */
  publicKey?: string;
  /** Epoch-0 account ROOT public key, 64 hex - what a second device pairs into. */
  accountRootPublicKey?: string;
  /** Whether this node can certify another device into its account. */
  holdsAccountRoot?: boolean;
  /** Whether the account has certified this node's device. False between
   *  `pair-init` and `pair-complete`; absent on a node too old to report it. */
  deviceCertified?: boolean;
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
