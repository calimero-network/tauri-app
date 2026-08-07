// Shared TTL cache over the node's installed-application list. Install and
// uninstall must call invalidateInstalledApps(); a node switch drops it itself.

import { apiClient } from "../lib/mero-client";
import { getSettings } from "./settings";

const TTL_MS = 5 * 60 * 1000;

type InstalledAppsResponse = Awaited<ReturnType<typeof apiClient.node.listApplications>>;

let cached: { at: number; response: InstalledAppsResponse } | null = null;
let inFlight: Promise<InstalledAppsResponse> | null = null;
let epoch = 0;
let node = "";

export async function listInstalledApps(): Promise<InstalledAppsResponse> {
  // App lists are per node, and not every switch reloads the window - onboarding
  // points the client at the node it just created without one.
  const target = getSettings().nodeUrl;
  if (target !== node) {
    node = target;
    invalidateInstalledApps();
  }

  if (cached && Date.now() - cached.at < TTL_MS) return cached.response;
  if (inFlight) return inFlight;

  const startedAt = epoch;
  inFlight = apiClient.node
    .listApplications()
    .then((response) => {
      // Never cache a failure or a read an install invalidated mid-flight.
      if (!response.error && epoch === startedAt) {
        // Frozen: callers share this array for the TTL; a stray sort must throw.
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
