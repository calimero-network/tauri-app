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

  const match = response.data.find((app: any) => {
    const metadata = decodeMetadata(app.metadata);
    const name: string | undefined = metadata?.name || metadata?.alias;
    return !!name && kebabCase(name) === dl.slug;
  });

  if (!match) {
    console.warn(`[deep-link] no installed app matches slug "${dl.slug}"`);
    return;
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
