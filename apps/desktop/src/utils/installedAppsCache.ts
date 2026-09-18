// Shared TTL cache over the node's installed-application list. Install and
// uninstall must call invalidateInstalledApps(); a node switch drops it itself.

import { apiClient } from "../lib/mero-client";
import { getSettings } from "./settings";
import { fetchBundleDisplay } from "./registry";
import { decodeMetadata } from "./appUtils";

const TTL_MS = 5 * 60 * 1000;
// Give one registry request this long to answer before it is cancelled and the
// next is tried - a slow or dead registry must never hold up the app list.
const DISPLAY_LOOKUP_TIMEOUT_MS = 4000;

type InstalledAppsResponse = Awaited<ReturnType<typeof apiClient.node.listApplications>>;

interface AppDisplay {
  name?: string;
  icon?: string;
  description?: string;
}

interface AppRow {
  package?: string;
  version?: string;
  metadata?: unknown;
}

/** True when the row names a package/version but its metadata has no name to show -
 *  the case for bytecode that arrived by blob share instead of a registry install. */
export function needsDisplayBackfill(app: AppRow): boolean {
  if (typeof app.package !== "string" || !app.package) return false;
  if (typeof app.version !== "string" || !app.version) return false;
  return !decodeMetadata(app.metadata)?.name;
}

// Keyed `${package}@${version}`. A published bundle's display never changes, so
// a hit outlives the list cache the Account poll drops every 30 s. A miss is held
// for the list TTL, so that poll does not ask every registry again on each tick.
const displayCache = new Map<string, AppDisplay>();
const displayMissedAt = new Map<string, number>();

async function lookupDisplay(pkg: string, version: string): Promise<AppDisplay | null> {
  const key = `${pkg}@${version}`;
  const memoized = displayCache.get(key);
  if (memoized) return memoized;
  if (Date.now() - (displayMissedAt.get(key) ?? -Infinity) < TTL_MS) return null;

  for (const registryUrl of getSettings().registries ?? []) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPLAY_LOOKUP_TIMEOUT_MS);
    try {
      const display = await fetchBundleDisplay(registryUrl, pkg, version, controller.signal);
      if (display) {
        displayCache.set(key, display);
        return display;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  displayMissedAt.set(key, Date.now());
  return null;
}

// Only display fields cross from a registry response into a row. Links stay
// node-sourced: the node's metadata is from a signed bundle, a registry answer is not.
async function backfillDisplays<T extends AppRow>(apps: T[]): Promise<T[]> {
  return Promise.all(
    apps.map(async (app) => {
      if (!needsDisplayBackfill(app)) return app;
      const display = await lookupDisplay(app.package!, app.version!);
      return display ? { ...app, metadata: display } : app;
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
