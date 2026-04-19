import { getAccessToken } from '../lib/token-storage';

// API lives at manager.cloud.calimero.network; cloud.calimero.network is
// the static portal and does not proxy /api/*.
const CLOUD_BASE_URL = 'https://manager.cloud.calimero.network';

export interface CloudNode {
  name: string;
  public_ip: string;
  plan: string;
  status: string;
}

export interface CloudContext {
  context_id: string;
  node_name: string;
  node_url: string;
  public_ip: string;
  plan: string;
  status: string;
}

export interface CloudProfile {
  display_name: string | null;
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

export async function getCloudContexts(
  idToken: string,
): Promise<CloudContext[]> {
  const res = await cloudFetch('/api/cloud/me/contexts', idToken);
  if (!res.ok) return [];
  return res.json();
}

export async function getCloudProfile(
  idToken: string,
): Promise<CloudProfile | null> {
  const res = await cloudFetch('/api/cloud/me/profile', idToken);
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
  const res = await cloudFetch(`/api/cloud/ha/enable/${contextId}`, idToken, {
    method: 'POST',
    body: JSON.stringify(groupId ? { group_id: groupId } : {}),
  });
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
  const res = await cloudFetch(`/api/cloud/ha/disable/${contextId}`, idToken, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(error?.detail || 'Failed to disable HA');
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
    `${nodeUrl}/admin-api/groups/${groupId}/settings/tee-admission-policy`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        allowed_mrtd: allowedMrtd ?? [],
        allowed_rtmr0: [],
        allowed_rtmr1: [],
        allowed_rtmr2: [],
        allowed_rtmr3: [],
        allowed_tcb_statuses: [],
        accept_mock: false,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to set TEE admission policy: ${text}`);
  }
}

/**
 * Enable HA end-to-end:
 * 1. Fetch fleet measurements from cloud (trusted MRTD values)
 * 2. Set TEE admission policy on the local node with those values
 * 3. Register HA request with cloud for fleet node assignment
 */
export async function enableHaForNamespace(
  idToken: string,
  nodeUrl: string,
  contextId: string,
  groupId: string,
): Promise<EnableHaResponse | null> {
  // 1. Fetch the fleet's trusted measurements from the cloud.
  const measurements = await getFleetMeasurements(idToken);
  if (!measurements.allowed_mrtd.length) {
    throw new Error('No fleet MRTD measurements available — cannot set admission policy');
  }

  // 2. Set TEE admission policy on the local node with the fleet's
  //    trusted MRTD values. Only TEE nodes matching these measurements
  //    will be admitted.
  await setTeeAdmissionPolicy(nodeUrl, groupId, measurements.allowed_mrtd);

  // 3. Register HA request with the cloud — fleet nodes will poll
  //    should-join and get assigned to this group.
  return enableHa(idToken, contextId, groupId);
}

export { CloudSessionExpiredError };
