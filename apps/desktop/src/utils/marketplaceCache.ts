/**
 * Caches raw registry app data (before installed-status is applied) so that
 * navigating back to the Marketplace page does not trigger a slow re-fetch
 * every time. Installed status is NOT cached - the Marketplace component
 * applies it on top from the live installedAppIds set.
 */

import type { AppSummary } from "./registry";

interface RegistryApps {
  registry: string;
  apps: AppSummary[];
}

interface CacheEntry {
  /** Sorted, serialised registry URL list so we can detect config changes */
  registriesKey: string;
  /** The cached registry results */
  results: RegistryApps[];
  /** Unix-ms timestamp when the cache was written */
  timestamp: number;
}

const STORAGE_KEY = "calimero-marketplace-cache";
const TTL_MS = 5 * 60 * 1000; // cache considered stale after this long

let memoryCache: CacheEntry | null = null;

/** Build a deterministic key from a list of registry URLs */
function buildRegistriesKey(registries: string[]): string {
  return [...registries]
    .map((u) => u.replace(/\/+$/, "").toLowerCase())
    .sort()
    .join("|");
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function readFromStorage(): CacheEntry | null {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    return JSON.parse(json) as CacheEntry;
  } catch {
    return null;
  }
}

function writeToStorage(entry: CacheEntry): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch (err) {
    console.warn("Failed to write marketplace cache to localStorage:", err);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get cached marketplace data.
 *
 * Returns `null` when there is no usable cache (first load or registries
 * changed). Otherwise returns the cached results together with an `isStale`
 * flag the caller can use to decide whether to trigger a background refresh.
 */
export function getMarketplaceCache(
  registries: string[]
): { results: RegistryApps[]; isStale: boolean } | null {
  const key = buildRegistriesKey(registries);

  // Try memory cache first (fastest)
  if (memoryCache && memoryCache.registriesKey === key) {
    const age = Date.now() - memoryCache.timestamp;
    return { results: memoryCache.results, isStale: age > TTL_MS };
  }

  // Fall back to localStorage
  const stored = readFromStorage();
  if (stored && stored.registriesKey === key) {
    // Populate memory cache
    memoryCache = stored;
    const age = Date.now() - stored.timestamp;
    return { results: stored.results, isStale: age > TTL_MS };
  }

  return null;
}

/** Store fresh marketplace data in the cache. */
export function setMarketplaceCache(registries: string[], results: RegistryApps[]): void {
  const entry: CacheEntry = {
    registriesKey: buildRegistriesKey(registries),
    results,
    timestamp: Date.now(),
  };

  memoryCache = entry;
  writeToStorage(entry);
}

/**
 * Invalidate the cache entirely. The next call to `getMarketplaceCache` will
 * return `null`, forcing a fresh fetch.
 */
export function invalidateMarketplaceCache(): void {
  memoryCache = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Touch the cache timestamp without changing the data. Useful after a
 * background refresh confirms the data hasn't changed (resets the TTL
 * without triggering a re-render).
 */
export function touchMarketplaceCache(): void {
  if (memoryCache) {
    memoryCache.timestamp = Date.now();
    writeToStorage(memoryCache);
  }
}
