import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { apiClient } from '../lib/mero-client';
import {
  appendParamsToUrl,
  decodeMetadata,
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
 * Outcome of trying to resolve + open a deep-link:
 *   - `opened`: the target app was opened — done.
 *   - `forget`: terminal — no installed app for this slug, or it has no
 *     frontend URL. Drop the link.
 *   - `retry`: transient (node not ready to list apps yet) — try again later.
 */
type OpenOutcome = 'opened' | 'retry' | 'forget';

/**
 * Resolve a deep-link `slug` → an *installed* app and open it with the deep-link
 * params appended to the app's frontend URL.
 *
 * Scope note: this routes to apps already installed on the node. Install-on-
 * demand for a missing app — and doing the namespace join in the desktop — is a
 * follow-up (the pending-intent work); today a slug with no installed app is
 * simply forgotten.
 *
 * The `<slug>` segment is the app's PACKAGE — the registry identifier (e.g.
 * `com.calimero.curb`): globally unique and stable across renames, unlike a
 * display-name-derived slug (which collides and breaks on rename). The node
 * returns it as `Application.package` for bundle/registry installs, and every
 * app's invite builder emits it (`calimero://<package>/join?…`).
 */
async function resolveAndOpen(dl: AppDeepLink): Promise<OpenOutcome> {
  const response = await apiClient.node.listApplications();
  if (response.error || !Array.isArray(response.data)) {
    // Node isn't ready to list apps yet (cold boot) — transient, retry.
    return 'retry';
  }

  const match = response.data.find((app: any) => !!app.package && app.package === dl.slug);

  if (!match) {
    console.warn(`[deep-link] no installed app matches slug "${dl.slug}" — ignoring link`);
    return 'forget';
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
 * few seconds to be ready to list apps. It clears the pending link only on a
 * terminal outcome (opened or forgotten), so a transient failure never drops it.
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
      for (let attempt = 0; attempt < 30 && !cancelled; attempt++) {
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
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();

    return () => {
      cancelled = true;
      unlistenPromise.then((off) => off && off()).catch(() => {});
    };
  }, [enabled]);
}
