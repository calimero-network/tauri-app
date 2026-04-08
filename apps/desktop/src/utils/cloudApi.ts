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

export { CloudSessionExpiredError };
