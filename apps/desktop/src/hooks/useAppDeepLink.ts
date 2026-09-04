import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { apiClient } from '../lib/mero-client';
import {
  appendParamsToUrl,
  decodeMetadata,
  openAppFrontend,
  sleep,
} from '../utils/appUtils';
import { listInstalledApps, invalidateInstalledApps } from '../utils/installedAppsCache';
import { fetchAppsFromRegistry } from '../utils/registry';

const DEEP_LINK_REGISTRY = 'https://apps.calimero.network';

/** Waits between cold-launch drain attempts. The launch URL lands within a
 *  second or two in practice; the long tail only covers a node still booting. */
const DRAIN_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000];

/**
 * Install-on-demand: fetch the latest published bundle for `pkg` (the deep-link
 * slug is the registry package) and install it on the node. Returns the new
 * applicationId, or null on failure. Empty metadata — the node reads the
 * bundle manifest's own metadata (name, links.frontend, package, etc.).
 */
async function installFromRegistry(pkg: string): Promise<string | null> {
  try {
    const bundles = await fetchAppsFromRegistry(DEEP_LINK_REGISTRY, { name: pkg });
    const version = bundles.find((b) => b.id === pkg)?.latest_version
      ?? bundles[0]?.latest_version;
    if (!version) {
      console.warn(`[deep-link] no published version for package "${pkg}"`);
      return null;
    }
    console.log(`[deep-link] installing ${pkg}@${version}`);
    const res = await apiClient.node.installApplication({ package: pkg, version });
    if (res.error || !res.data?.applicationId) {
      console.warn(`[deep-link] install failed for ${pkg}:`, res.error?.message ?? 'no applicationId');
      return null;
    }
    invalidateInstalledApps();
    return res.data.applicationId;
  } catch (e) {
    console.warn(`[deep-link] install-on-demand error for ${pkg}:`, e);
    return null;
  }
}

/**
 * Payload emitted by the host's `on_open_url` handler for an app deep-link
 * shaped `<slug>/<action>?<params>` (custom scheme `calimero://…` or the
 * Universal Link host `https://links.calimero.network/…`). The OAuth callback
 * is NOT delivered here — the host routes it to the cloud-auth path instead.
 */
export interface AppDeepLink {
  slug: string;
  action: string;
  /** Raw query string without the leading `?`, e.g. `invitation=X`. */
  params: string;
}

/**
 * Outcome of trying to resolve + open a deep-link:
 *   - `opened`: the target app was opened — done.
 *   - `forget`: terminal — no installed app for this slug, or it has no
 *     frontend URL. Drop the link.
 *   - `retry`: transient (node not ready to list apps yet) — try again later.
 */
type OpenOutcome = 'opened' | 'retry' | 'forget';

/**
 * Resolve a deep-link `slug` → an app and open it with the deep-link params
 * appended to the app's frontend URL. If the app isn't installed, install it
 * from the registry first (install-on-demand), then open it.
 *
 * The `<slug>` segment is the app's PACKAGE — the registry identifier (e.g.
 * `com.calimero.curb`): globally unique and stable across renames, unlike a
 * display-name-derived slug (which collides and breaks on rename). The node
 * returns it as `Application.package` for bundle/registry installs, and every
 * app's invite builder emits it (`calimero://<package>/join?…`).
 */
async function resolveAndOpen(dl: AppDeepLink): Promise<OpenOutcome> {
  const response = await listInstalledApps();
  if (response.error || !Array.isArray(response.data)) {
    // Node isn't ready to list apps yet (cold boot) — transient, retry.
    return 'retry';
  }

  const byPackage = (apps: any[]) =>
    apps.find((app: any) => !!app.package && app.package === dl.slug);

  let match = byPackage(response.data);

  // Install-on-demand: the app for this package isn't installed — fetch it from
  // the registry (the slug IS the package), install, then open.
  if (!match) {
    console.log(`[deep-link] "${dl.slug}" not installed — installing from registry…`);
    const installedId = await installFromRegistry(dl.slug);
    if (!installedId) {
      console.warn(`[deep-link] could not install "${dl.slug}" — forgetting link`);
      return 'forget';
    }
    const relist = await listInstalledApps();
    const apps = Array.isArray(relist.data) ? relist.data : [];
    match = apps.find((a: any) => a.id === installedId) ?? byPackage(apps);
    if (!match) {
      console.warn(`[deep-link] installed "${dl.slug}" but could not find it to open`);
      return 'forget';
    }
  }

  const metadata = decodeMetadata(match.metadata);
  const appName: string = metadata?.name || metadata?.alias || 'Application';
  const frontendUrl: string | undefined = metadata?.links?.frontend;
  if (!frontendUrl) {
    console.warn(`[deep-link] app "${appName}" has no frontend URL; cannot open`);
    return 'forget';
  }

  // Append the deep-link params to the frontend URL so the app reads them on
  // load (e.g. mero-chat's extractInvitationFromUrl reads ?invitation=...).
  const urlWithParams = appendParamsToUrl(frontendUrl, dl.params);

  await openAppFrontend(
    urlWithParams,
    appName,
    (err) => console.error('[deep-link] failed to open app:', err),
    { applicationId: match.id },
  );
  return 'opened';
}

/**
 * Listens for app deep-links and opens the target app.
 *
 * Two channels, deduped against each other by link key:
 *   - `app-deep-link` Tauri event (hot: app already running when the URL fires).
 *   - a cold-launch drain that polls the pending / current deep-link the OS
 *     delivered before this listener existed.
 *
 * The drain must poll, not read once: on macOS the launch URL arrives via an
 * Apple Event that can land after this effect mounts, and the node may take a
 * few seconds to be ready to list apps. It backs off over roughly the same 30s
 * window a flat second-by-second poll covered, for a quarter of the calls. It
 * clears the pending link only on a terminal outcome (opened or forgotten), so
 * a transient failure never drops it.
 *
 * `enabled` gates activation until the app is past onboarding and the mero
 * client is ready — resolving requires listing installed apps.
 */
export function useAppDeepLink(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // Dedup the live event and the cold drain so the same link isn't handled
    // twice. Key includes params so distinct links are treated separately.
    const handled = new Set<string>();
    const keyOf = (dl: AppDeepLink) => `${dl.slug}/${dl.action}?${dl.params}`;
    const handle = async (dl: AppDeepLink): Promise<OpenOutcome> => {
      const key = keyOf(dl);
      if (handled.has(key)) return 'opened'; // another path already took it
      handled.add(key);
      const outcome = await resolveAndOpen(dl);
      if (outcome === 'retry') handled.delete(key); // allow a later attempt
      return outcome;
    };

    const unlistenPromise = listen<AppDeepLink>('app-deep-link', (event) => {
      if (cancelled) return;
      handle(event.payload)
        .then((o) => {
          if (o !== 'retry') invoke('clear_pending_app_deep_link').catch(() => {});
        })
        .catch((e) => console.warn('[deep-link] resolve/open failed:', e));
    }).catch(() => null);

    (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          // Two sources: `pending` (set via our on_open_url listener, which can
          // race and miss on macOS) and `current` (the plugin's own launch-URL
          // store, reliable on cold launch). Prefer whichever is present.
          let dl = await invoke<AppDeepLink | null>('get_pending_app_deep_link');
          if (!dl) dl = await invoke<AppDeepLink | null>('get_current_app_deep_link');
          if (dl) {
            const outcome = await handle(dl);
            if (outcome !== 'retry') {
              await invoke('clear_pending_app_deep_link').catch(() => {});
              return;
            }
          }
        } catch (e) {
          console.warn('[deep-link] cold-start drain error:', e);
        }
        const wait = DRAIN_BACKOFF_MS[attempt];
        if (cancelled || wait === undefined) return;
        await sleep(wait);
      }
    })();

    return () => {
      cancelled = true;
      unlistenPromise.then((off) => off && off()).catch(() => {});
    };
  }, [enabled]);
}
