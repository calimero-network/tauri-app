import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { apiClient } from '../lib/mero-client';
import {
  appendParamsToUrl,
  decodeMetadata,
  kebabCase,
  openAppFrontend,
} from '../utils/appUtils';
import { fetchAppsFromRegistry } from '../utils/registry';

/**
 * Deep-link slug → registry package, for install-on-demand when the app isn't
 * installed. INTERIM: this map is the stopgap until Track C's manifest
 * `handlers.slug` + a registry slug index replace it. Keys are the same slugs
 * the link minter uses (kebab of the app's display name).
 */
const SLUG_PACKAGE_MAP: Record<string, string> = {
  'mero-chat': 'com.calimero.curb',
  'mero-meet': 'com.calimero.meromeet',
  'mero-drive': 'com.calimero.mero-drive-docs',
};

const DEEP_LINK_REGISTRY = 'https://apps.calimero.network';

/**
 * Install-on-demand: fetch the latest published bundle for `pkg` from the
 * registry and install it on the node. Returns the new applicationId, or null
 * on failure. The `.mpk` install uses empty metadata — the node reads the
 * bundle manifest's own metadata (name, links.frontend, etc.).
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
    // Registry artifact URL shape: /artifacts/<pkg>/<version>/<pkg>-<version>.mpk
    const mpkUrl = `${DEEP_LINK_REGISTRY}/artifacts/${pkg}/${version}/${pkg}-${version}.mpk`;
    console.log(`[deep-link] installing ${pkg}@${version} from ${mpkUrl}`);
    const res = await apiClient.node.installApplication({ url: mpkUrl, metadata: [] });
    if (res.error || !res.data?.applicationId) {
      console.warn(`[deep-link] install failed for ${pkg}:`, res.error?.message ?? 'no applicationId');
      return null;
    }
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
 * Resolve a deep-link `slug` → an installed app and open it with the deep-link
 * params appended to the app's frontend URL.
 *
 * Slug resolution is INTERIM: we match `slug` against each installed app's
 * display name kebab-cased ("Mero Chat" → "mero-chat"). Track C will add an
 * explicit `handlers.slug` field to the app manifest; prefer that field once it
 * ships. Until then, kebab(name) is the contract shared with the link minter.
 */
async function resolveAndOpen(dl: AppDeepLink): Promise<void> {
  const response = await apiClient.node.listApplications();
  if (response.error || !Array.isArray(response.data)) {
    console.warn(
      '[deep-link] could not list installed apps:',
      response.error?.message ?? 'no data',
    );
    return;
  }

  const findBySlug = (apps: any[]) => apps.find((app: any) => {
    const metadata = decodeMetadata(app.metadata);
    const name: string | undefined = metadata?.name || metadata?.alias;
    return !!name && kebabCase(name) === dl.slug;
  });

  let match = findBySlug(response.data);

  // Install-on-demand (flow Case B): the app for this slug isn't installed —
  // install it from the registry, then open it.
  if (!match) {
    const pkg = SLUG_PACKAGE_MAP[dl.slug];
    if (!pkg) {
      console.warn(`[deep-link] no installed app and no known package for slug "${dl.slug}"`);
      return;
    }
    console.log(`[deep-link] "${dl.slug}" not installed — installing ${pkg} from the registry…`);
    const installedId = await installFromRegistry(pkg);
    if (!installedId) return;
    const relist = await apiClient.node.listApplications();
    const apps = Array.isArray(relist.data) ? relist.data : [];
    match = apps.find((a: any) => a.id === installedId) ?? findBySlug(apps);
    if (!match) {
      console.warn(`[deep-link] installed ${pkg} but could not find it to open`);
      return;
    }
  }

  const metadata = decodeMetadata(match.metadata);
  const appName: string = metadata?.name || metadata?.alias || 'Application';
  const frontendUrl: string | undefined = metadata?.links?.frontend;
  if (!frontendUrl) {
    console.warn(`[deep-link] app "${appName}" has no frontend URL; cannot open`);
    return;
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
}

/**
 * Listens for app deep-links and opens the target app.
 *
 * Two channels, mirroring the cloud-auth flow:
 *   - `app-deep-link` Tauri event (hot-launch: app already running).
 *   - polling `get_pending_app_deep_link` once (cold-launch: the OS launched
 *     the app with the deep-link before any listener existed).
 *
 * `enabled` gates activation until the app is past onboarding and the mero
 * client is ready — resolving requires listing installed apps.
 */
export function useAppDeepLink(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const unlistenPromise = listen<AppDeepLink>('app-deep-link', (event) => {
      if (cancelled) return;
      resolveAndOpen(event.payload).catch((e) =>
        console.warn('[deep-link] resolve/open failed:', e),
      );
    }).catch(() => null);

    // Cold-launch: drain any deep-link the OS delivered before this listener.
    (async () => {
      try {
        const pending = await invoke<AppDeepLink | null>('get_pending_app_deep_link');
        if (cancelled || !pending) return;
        await invoke('clear_pending_app_deep_link');
        await resolveAndOpen(pending);
      } catch (e) {
        console.warn('[deep-link] cold-start drain failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      unlistenPromise.then((off) => off && off()).catch(() => {});
    };
  }, [enabled]);
}
