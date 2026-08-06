/**
 * TTL cache over the node's installed-application list.
 *
 * Six surfaces read the same list (home page, Applications, Marketplace,
 * Namespaces, Onboarding, deep-link resolution) and each used to issue its own
 * round trip. They share one here, deduped while a request is in flight.
 *
 * Anything that installs or uninstalls must call `invalidateInstalledApps()`.
 */

import { apiClient, type ApiResponse } from "../lib/mero-client";

/** Default time-to-live: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

let cached: { at: number; response: ApiResponse<any[]> } | null = null;
let inFlight: Promise<ApiResponse<any[]>> | null = null;

export async function listInstalledApps(
  ttlMs: number = DEFAULT_TTL_MS
): Promise<ApiResponse<any[]>> {
  if (cached && Date.now() - cached.at < ttlMs) return cached.response;
  if (inFlight) return inFlight;

  inFlight = apiClient.node
    .listApplications()
    .then((response) => {
      // Failures are never cached: a 401 on a stale token or a node that is
      // still booting would otherwise pin every caller to it for the whole TTL.
      if (!response.error) cached = { at: Date.now(), response };
      return response;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Drop the cache so the next read hits the node. Call after install/uninstall. */
export function invalidateInstalledApps(): void {
  cached = null;
}
