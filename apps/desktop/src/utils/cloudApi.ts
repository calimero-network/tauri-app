import { getAccessToken } from '../lib/token-storage';
import { getSettings, saveSettings } from './settings';
import { isMdmaSessionToken, isTokenExpired } from './jwt';

// API lives at manager.cloud.calimero.network; cloud.calimero.network is
// the static portal and does not proxy /api/*. Exported so cloudAuth
// can reuse it — we don't want two independent constants drifting.
export const CLOUD_BASE_URL = 'https://manager.cloud.calimero.network';
const MDMA_SESSION_REFRESH_HEADER = 'X-MDMA-Session-Refresh';

export interface CloudNode {
  name: string;
  public_ip: string;
  plan: string;
  status: string;
}

export interface CloudSubscription {
  plan: string;
  status: string;
  current_period_end: string | null;
}

class CloudSessionExpiredError extends Error {
  constructor() {
    super('Cloud session expired');
    this.name = 'CloudSessionExpiredError';
  }
}

async function cloudFetch(
  path: string,
  idToken: string,
  options?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${CLOUD_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    throw new CloudSessionExpiredError();
  }

  // Rolling refresh: the server re-issued our session silently because
  // this one was past the refresh threshold. Persist the new token
  // directly to settings — next call reads from settings.cloudIdToken
  // and picks it up. We intentionally don't propagate via React state
  // or events: same sid = same logical session, so there's nothing
  // UI-level to re-derive, and routing refresh through render would
  // re-fire every useEffect that depends on the token.
  //
  // Only honoured on a successful response. A refresh header attached
  // to a 4xx/5xx response is suspicious (either a misbehaving server
  // or a header-injecting MITM trying to plant a token on us during a
  // failure path) — the 401 branch above already threw, but the same
  // logic applies to other non-ok statuses. Drop silently.
  if (!res.ok) {
    return res;
  }

  // Validate the header value before persisting it. An MDMA-issued
  // JWT that is not yet expired is the only shape we should ever
  // write to settings.cloudIdToken via this path; anything else
  // (wrong issuer, malformed, already-expired) we silently drop and
  // keep the current token, which the caller will detect as expired
  // via isTokenExpired on the next request.
  const refreshed = res.headers.get(MDMA_SESSION_REFRESH_HEADER);
  if (refreshed && isMdmaSessionToken(refreshed) && !isTokenExpired(refreshed)) {
    const settings = getSettings();
    // Only update if the session we just used is still the active one;
    // avoids clobbering a fresh login that landed between the request
    // leaving and the response arriving.
    if (settings.cloudIdToken === idToken) {
      // saveSettings can throw if localStorage is full or unavailable
      // (Safari private mode, quota exceeded). The rolling refresh is a
      // best-effort silent renewal — if we can't persist the new token
      // the user keeps the old one and re-auths at its exp, which is
      // strictly better than letting the network response surface a
      // storage error to the caller.
      try {
        saveSettings({ ...settings, cloudIdToken: refreshed });
      } catch (err) {
        console.warn('Failed to persist refreshed MDMA session token:', err);
      }
    }
  }

  return res;
}

/**
 * Get the user's assigned cloud node. Also triggers auto-registration
 * on first call (creates free plan account + default context).
 */
export async function getCloudNode(
  idToken: string,
): Promise<CloudNode | null> {
  const res = await cloudFetch('/api/cloud/me/node', idToken);
  if (!res.ok) return null;
  return res.json();
}

export async function getCloudSubscription(
  idToken: string,
): Promise<CloudSubscription | null> {
  const res = await cloudFetch('/api/cloud/me/subscription', idToken);
  if (!res.ok) return null;
  return res.json();
}

export interface CloudGroup {
  group_id: string;
  namespace_id: string | null;
  contexts: string[];
  ha_status: string;
  ha_enabled_at: string | null;
  fleet_replicas: { active: number; assigned: number; limit: number };
}

export async function getCloudGroups(idToken: string): Promise<CloudGroup[]> {
  const res = await cloudFetch('/api/cloud/me/groups', idToken);
  if (!res.ok) return [];
  return res.json();
}

// ── HA (High Availability) via TEE Fleet Nodes ──

export interface FleetMeasurements {
  release_tag: string;
  allowed_mrtd: string[];
  allowed_rtmr0: string[];
  allowed_rtmr1: string[];
  allowed_rtmr2: string[];
  allowed_rtmr3: string[];
}

/**
 * Fetch the fleet's trusted TEE measurements (MRTD, RTMR values)
 * from the cloud. Used to populate set_tee_admission_policy.
 */
export async function getFleetMeasurements(
  idToken: string,
): Promise<FleetMeasurements> {
  const res = await cloudFetch('/api/cloud/fleet/measurements', idToken);
  if (!res.ok) {
    throw new Error('Failed to fetch fleet measurements');
  }
  return res.json();
}

export interface EnableHaResponse {
  status: string;
  context_id: string;
}

/**
 * Enable HA for a context — requests TEE fleet nodes to join this
 * namespace/group. Requires a paid plan.
 */
export async function enableHa(
  idToken: string,
  contextId: string,
  groupId?: string,
): Promise<EnableHaResponse | null> {
  const res = await cloudFetch(
    `/api/cloud/me/contexts/${encodeURIComponent(contextId)}/enable-ha`,
    idToken,
    {
      method: 'POST',
      body: JSON.stringify(groupId ? { group_id: groupId } : {}),
    },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    if (res.status === 402) {
      throw new Error(error?.detail?.message || 'Plan limit reached — upgrade to enable HA');
    }
    throw new Error(error?.detail || 'Failed to enable HA');
  }
  return res.json();
}

/**
 * Disable HA for a context.
 */
export async function disableHa(
  idToken: string,
  contextId: string,
): Promise<void> {
  const res = await cloudFetch(
    `/api/cloud/me/contexts/${encodeURIComponent(contextId)}/disable-ha`,
    idToken,
    { method: 'POST' },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(error?.detail || 'Failed to disable HA');
  }
}

export interface NamespaceHaGroup {
  group_id: string;
  context_id: string;
}

export interface EnableHaNamespaceResponse {
  status: string;
  namespace_id: string;
  groups: { group_id: string; context_id: string; status: string }[];
}

/**
 * Enable HA for every group in a namespace in one call. Client is
 * responsible for enumerating the groups and picking a representative
 * context_id per group (manager needs the context for billing + row
 * bookkeeping but does not itself know the namespace topology).
 */
export async function enableHaNamespace(
  idToken: string,
  namespaceId: string,
  groups: NamespaceHaGroup[],
): Promise<EnableHaNamespaceResponse> {
  const res = await cloudFetch(
    `/api/cloud/me/namespaces/${encodeURIComponent(namespaceId)}/enable-ha`,
    idToken,
    { method: 'POST', body: JSON.stringify({ groups }) },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    if (res.status === 402) {
      throw new Error(error?.detail?.message || 'Plan limit reached — upgrade to enable HA');
    }
    throw new Error(error?.detail || 'Failed to enable HA for namespace');
  }
  return res.json();
}

/**
 * Disable HA for every group previously enabled under this namespace.
 */
export async function disableHaNamespace(
  idToken: string,
  namespaceId: string,
): Promise<void> {
  const res = await cloudFetch(
    `/api/cloud/me/namespaces/${encodeURIComponent(namespaceId)}/disable-ha`,
    idToken,
    { method: 'POST' },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(error?.detail || 'Failed to disable HA for namespace');
  }
}

// ── Local Node Admin API ──

/**
 * Set the TEE admission policy on a group via the local node's admin API.
 * This must be called after enabling HA so that fleet TEE nodes can be
 * admitted into the group's governance DAG.
 *
 * accept_mock is always false — only real TDX attestations are accepted.
 * allowedMrtd should be populated from the cloud's fleet measurements;
 * an empty list means any MRTD is accepted (not recommended for production).
 */
export async function setTeeAdmissionPolicy(
  nodeUrl: string,
  groupId: string,
  allowedMrtd?: string[],
): Promise<void> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error('Not authenticated to local node — sign in first');
  }
  const res = await fetch(
    `${nodeUrl}/admin-api/groups/${encodeURIComponent(groupId)}/settings/tee-admission-policy`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        // The merod admin API deserialises this request with
        // `#[serde(rename_all = "camelCase")]` (see
        // SetTeeAdmissionPolicyApiRequest in
        // calimero-network/core: crates/server/primitives/src/admin/mod.rs).
        // Snake_case keys are silently ignored as unknown fields and every
        // field falls through to its #[serde(default)] — so the server sees
        // allowed_mrtd: [] and accept_mock: false, and validation rejects
        // with a misleading "at least one MRTD must be specified" error.
        allowedMrtd: allowedMrtd ?? [],
        allowedRtmr0: [],
        allowedRtmr1: [],
        allowedRtmr2: [],
        allowedRtmr3: [],
        allowedTcbStatuses: [],
        acceptMock: false,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to set TEE admission policy: ${text}`);
  }
}

/**
 * Enable HA end-to-end for a namespace:
 * 1. Fetch fleet measurements from cloud once (trusted MRTD values).
 * 2. Set the TEE admission policy on the *namespace root only*. Subgroup
 *    policies are ignored by core (namespace-scoped since rc.29 /
 *    calimero-network/core#2188) — applying them would error. Auto-follow
 *    propagates fleet-node membership into subgroups without a second
 *    admission check.
 * 3. Register the namespace with cloud. MDMA still needs the full group
 *    list for billing + per-group status rows until the server-side
 *    flattening lands, so the caller keeps enumerating groups.
 */
export async function enableHaForNamespace(
  idToken: string,
  nodeUrl: string,
  namespaceId: string,
  groups: NamespaceHaGroup[],
): Promise<EnableHaNamespaceResponse> {
  if (groups.length === 0) {
    throw new Error('Namespace has no groups to enable HA on');
  }

  const measurements = await getFleetMeasurements(idToken);
  if (!measurements.allowed_mrtd.length) {
    throw new Error('No fleet MRTD measurements available — cannot set admission policy');
  }

  // The namespace root's group_id equals the namespaceId. Set the policy
  // there and only there — subgroups inherit it via resolve-to-root.
  await setTeeAdmissionPolicy(nodeUrl, namespaceId, measurements.allowed_mrtd);

  return enableHaNamespace(idToken, namespaceId, groups);
}

export { CloudSessionExpiredError };
