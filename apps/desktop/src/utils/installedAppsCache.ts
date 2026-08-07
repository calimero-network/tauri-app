/**
 * TTL cache over the node's installed-application list.
 *
 * Six surfaces read the same list (home page, Applications, Marketplace,
 * Namespaces, Onboarding, deep-link resolution) and each used to issue its own
 * round trip. They share one here, deduped while a request is in flight.
 *
 * Anything that installs or uninstalls must call `invalidateInstalledApps()`;
 * a change of target node drops the entry on its own.
 * The list handed out is shared and frozen - copy it to sort or filter.
 */

import { apiClient } from "../lib/mero-client";
import { getSettings } from "./settings";

/** Default time-to-live: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

type InstalledAppsResponse = Awaited<ReturnType<typeof apiClient.node.listApplications>>;

let cached: { at: number; response: InstalledAppsResponse } | null = null;
let inFlight: Promise<InstalledAppsResponse> | null = null;
let epoch = 0;
let node = "";

export async function listInstalledApps(
  ttlMs: number = DEFAULT_TTL_MS
): Promise<InstalledAppsResponse> {
  // App lists are per node, and not every switch reloads the window - onboarding
  // points the client at the node it just created without one.
  const target = getSettings().nodeUrl;
  if (target !== node) {
    node = target;
    invalidateInstalledApps();
  }

  if (cached && Date.now() - cached.at < ttlMs) return cached.response;
  if (inFlight) return inFlight;

  const startedAt = epoch;
  inFlight = apiClient.node
    .listApplications()
    .then((response) => {
      // Failures are never cached: a 401 on a stale token or a node that is
      // still booting would otherwise pin every caller to it for the whole TTL.
      // Nor is a read that an install invalidated mid-flight - it describes the
      // node from before the install, so it answers its own caller and no one else.
      if (!response.error && epoch === startedAt) {
        // Six callers hold this same array for the whole TTL, so an in-place
        // sort or splice by one of them has to fail loudly, not corrupt the rest.
        if (response.data) Object.freeze(response.data);
        cached = { at: Date.now(), response };
      }
      return response;
    })
    .finally(() => {
      if (epoch === startedAt) inFlight = null;
    });

  return inFlight;
}

/** Drop the cache so the next read hits the node. Call after install/uninstall. */
export function invalidateInstalledApps(): void {
  cached = null;
  inFlight = null;
  epoch++;
}
