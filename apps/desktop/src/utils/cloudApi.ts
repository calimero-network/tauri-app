const CLOUD_BASE_URL = 'https://cloud.calimero.network';

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

// ── HA (High Availability) via TEE Fleet Nodes ──

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
  await cloudFetch(`/api/cloud/ha/disable/${contextId}`, idToken, {
    method: 'POST',
  });
}

// ── Local Node Admin API ──

/**
 * Set the TEE admission policy on a group via the local node's admin API.
 * This must be called after enabling HA so that fleet TEE nodes can be
 * admitted into the group's governance DAG.
 */
export async function setTeeAdmissionPolicy(
  nodeUrl: string,
  groupId: string,
  options?: {
    allowedMrtd?: string[];
    acceptMock?: boolean;
  },
): Promise<void> {
  const res = await fetch(
    `${nodeUrl}/admin-api/groups/${groupId}/settings/tee-admission-policy`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowed_mrtd: options?.allowedMrtd ?? [],
        allowed_rtmr0: [],
        allowed_rtmr1: [],
        allowed_rtmr2: [],
        allowed_rtmr3: [],
        allowed_tcb_statuses: [],
        accept_mock: options?.acceptMock ?? false,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to set TEE admission policy: ${text}`);
  }
}

/**
 * Enable HA end-to-end: sets TEE admission policy on the local node,
 * then registers the HA request with the cloud.
 */
export async function enableHaForNamespace(
  idToken: string,
  nodeUrl: string,
  contextId: string,
  groupId: string,
  options?: {
    allowedMrtd?: string[];
    acceptMock?: boolean;
  },
): Promise<EnableHaResponse | null> {
  // 1. Set TEE admission policy on the local node so fleet nodes
  //    can be admitted when they present valid attestations.
  await setTeeAdmissionPolicy(nodeUrl, groupId, options);

  // 2. Register HA request with the cloud — fleet nodes will poll
  //    should-join and get assigned to this group.
  return enableHa(idToken, contextId, groupId);
}

export { CloudSessionExpiredError };
