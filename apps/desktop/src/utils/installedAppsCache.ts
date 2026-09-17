// Shared TTL cache over the node's installed-application list. Install and
// uninstall must call invalidateInstalledApps(); a node switch drops it itself.

import { apiClient } from "../lib/mero-client";
import { getSettings } from "./settings";
import { fetchBundleDisplay } from "./registry";
import { needsDisplayBackfill, withDisplay, type AppDisplay, type AppRow } from "./appDisplay";

const TTL_MS = 5 * 60 * 1000;
// Give one registry request this long to answer before moving to the next -
// a slow or dead registry must never hold up the app list.
const DISPLAY_LOOKUP_TIMEOUT_MS = 4000;

type InstalledAppsResponse = Awaited<ReturnType<typeof apiClient.node.listApplications>>;

// Keyed `${package}@${version}`. A published bundle's display never changes, so
// a hit outlives the list cache the Account poll drops every 30 s; misses are retried.
const displayCache = new Map<string, AppDisplay>();

async function lookupDisplay(pkg: string, version: string): Promise<AppDisplay | null> {
  const key = `${pkg}@${version}`;
  const memoized = displayCache.get(key);
  if (memoized) return memoized;

  for (const registryUrl of getSettings().registries ?? []) {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), DISPLAY_LOOKUP_TIMEOUT_MS));
    const display = await Promise.race([fetchBundleDisplay(registryUrl, pkg, version), timeout]);
    if (display) {
      displayCache.set(key, display);
      return display;
    }
  }
  return null;
}

// Only display fields cross from a registry response into a row. Links stay
// node-sourced: the node's metadata is from a signed bundle, a registry answer is not.
async function backfillDisplays<T extends AppRow>(apps: T[]): Promise<T[]> {
  return Promise.all(
    apps.map(async (app) => {
      if (!needsDisplayBackfill(app)) return app;
      const display = await lookupDisplay(app.package!, app.version!);
      return withDisplay(app, display);
    }),
  );
}

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
    .then(async (response) => {
      // Never cache a failure or a read an install invalidated mid-flight.
      if (!response.error && epoch === startedAt) {
        if (response.data) {
          response.data = await backfillDisplays(response.data);
          // Frozen: callers share this array for the TTL; a stray sort must throw.
          Object.freeze(response.data);
        }
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
