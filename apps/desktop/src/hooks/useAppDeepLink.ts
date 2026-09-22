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
import { useToast } from '../contexts/ToastContext';

const DEEP_LINK_REGISTRY = 'https://apps.calimero.network';

/** Waits between cold-launch drain attempts. The launch URL lands within a
 *  second or two in practice; the long tail only covers a node still booting. */
const DRAIN_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000, 15000];

/**
 * How this hook talks to the user.
 *
 * Everything below used to report only through `console.log`/`console.warn`, so
 * following an invite link looked like nothing happening: the install-on-demand
 * below downloads and installs a WASM bundle — seconds, sometimes more — with
 * no window open yet and no indication the click registered. Worse, all three
 * terminal failures (no published version, install refused, no frontend URL)
 * dropped the link in silence, which is indistinguishable from a broken link.
 */
export interface Reporter {
  /** Long-running work. Returns a function that clears the message. */
  progress: (message: string) => () => void;
  failed: (message: string) => void;
  done: (message: string) => void;
}

/**
 * A progress handle is cleared on more than one path — explicitly, when one
 * stage hands over to the next, and again from a `finally` that guarantees it
 * happens at all. Clearing twice must not mean two calls into the UI.
 */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

/**
 * Wraps a reporter so that anything it is asked to say first takes down a
 * message that outranks it.
 *
 * The drain's “waiting for the node to finish starting” is only true while the
 * resolver says nothing at all — which is exactly the `'retry'` path, since
 * every other outcome reports something. Once the node answers, that message
 * would sit next to “Installing …” describing a state the app has left, for
 * the whole length of the slowest step in the path.
 */
export function supersede(stop: () => void, inner: Reporter): Reporter {
  return {
    progress: (message) => {
      stop();
      return inner.progress(message);
    },
    failed: (message) => {
      stop();
      inner.failed(message);
    },
    done: (message) => {
      stop();
      inner.done(message);
    },
  };
}

/**
 * Install-on-demand: fetch the latest published bundle for `pkg` (the deep-link
 * slug is the registry package) and install it on the node. Returns the new
 * applicationId, or null on failure. Empty metadata — the node reads the
 * bundle manifest's own metadata (name, links.frontend, package, etc.).
 */
async function installFromRegistry(pkg: string, report: Reporter): Promise<string | null> {
  const clear = once(report.progress(`Looking up ${pkg} in the registry\u2026`));
  try {
    const bundles = await fetchAppsFromRegistry(DEEP_LINK_REGISTRY, { name: pkg });
    const version = bundles.find((b) => b.id === pkg)?.latest_version
      ?? bundles[0]?.latest_version;
    if (!version) {
      console.warn(`[deep-link] no published version for package "${pkg}"`);
      report.failed(`\u201c${pkg}\u201d is not published in the registry, so this link cannot be opened.`);
      return null;
    }
    console.log(`[deep-link] installing ${pkg}@${version}`);
    // Downloading and installing a bundle is the slowest step in the whole
    // path, and until now the only step with no window open to show for it.
    clear();
    const clearInstall = once(report.progress(`Installing ${pkg} ${version}\u2026 this can take a moment.`));
    try {
      const res = await apiClient.node.installApplication({ package: pkg, version });
      if (res.error || !res.data?.applicationId) {
        const why = res.error?.message ?? 'the node returned no applicationId';
        console.warn(`[deep-link] install failed for ${pkg}:`, why);
        report.failed(`Could not install ${pkg}: ${why}`);
        return null;
      }
      invalidateInstalledApps();
      return res.data.applicationId;
    } finally {
      clearInstall();
    }
  } catch (e) {
    console.warn(`[deep-link] install-on-demand error for ${pkg}:`, e);
    report.failed(
      `Could not install ${pkg}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  } finally {
    clear();
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
export type OpenOutcome = 'opened' | 'retry' | 'forget';

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
export async function resolveAndOpen(dl: AppDeepLink, report: Reporter): Promise<OpenOutcome> {
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
    const installedId = await installFromRegistry(dl.slug, report);
    if (!installedId) {
      // installFromRegistry has already said why.
      console.warn(`[deep-link] could not install "${dl.slug}" — forgetting link`);
      return 'forget';
    }
    const relist = await listInstalledApps();
    const apps = Array.isArray(relist.data) ? relist.data : [];
    match = apps.find((a: any) => a.id === installedId) ?? byPackage(apps);
    if (!match) {
      console.warn(`[deep-link] installed "${dl.slug}" but could not find it to open`);
      report.failed(`Installed ${dl.slug}, but the node did not list it. Try the link again.`);
      return 'forget';
    }
    report.done(`Installed ${dl.slug}`);
  }

  const metadata = decodeMetadata(match.metadata);
  const appName: string = metadata?.name || metadata?.alias || 'Application';
  const frontendUrl: string | undefined = metadata?.links?.frontend;
  if (!frontendUrl) {
    console.warn(`[deep-link] app "${appName}" has no frontend URL; cannot open`);
    report.failed(`${appName} has no frontend to open. Its bundle declares no \u201clinks.frontend\u201d.`);
    return 'forget';
  }

  // Append the deep-link params to the frontend URL so the app reads them on
  // load (e.g. mero-chat's extractInvitationFromUrl reads ?invitation=...).
  const urlWithParams = appendParamsToUrl(frontendUrl, dl.params);

  // `join` is the action every app's invite builder emits. Naming it is the
  // difference between "a window will appear shortly" and "did my click do
  // anything?" — the whole of the reported complaint.
  const clear = once(report.progress(
    dl.action === 'join'
      ? `Opening ${appName} to join\u2026`
      : `Opening ${appName}\u2026`,
  ));
  try {
    await openAppFrontend(
      urlWithParams,
      appName,
      (err) => {
        console.error('[deep-link] failed to open app:', err);
        report.failed(`Could not open ${appName}: ${err instanceof Error ? err.message : String(err)}`);
      },
      { applicationId: match.id },
    );
  } finally {
    clear();
  }
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
  const toast = useToast();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    // A toast fired after unmount would outlive the link it describes.
    const report: Reporter = {
      progress: (message) => {
        if (cancelled) return () => {};
        const id = toast.info(message, 0); // 0 = hold until we clear it
        return () => toast.removeToast(id);
      },
      failed: (message) => {
        if (cancelled) return;
        // Longer than the default: this is the only trace of a link that did
        // not open, and the user has to read a package name out of it.
        toast.error(message, 12000);
      },
      done: (message) => {
        if (cancelled) return;
        toast.success(message);
      },
    };

    // Dedup the live event and the cold drain so the same link isn't handled
    // twice. Key includes params so distinct links are treated separately.
    const handled = new Set<string>();
    const keyOf = (dl: AppDeepLink) => `${dl.slug}/${dl.action}?${dl.params}`;
    const handle = async (dl: AppDeepLink, using: Reporter = report): Promise<OpenOutcome> => {
      const key = keyOf(dl);
      if (handled.has(key)) return 'opened'; // another path already took it
      handled.add(key);
      const outcome = await resolveAndOpen(dl, using);
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

    // Held open while the drain is waiting on a node that cannot list apps yet.
    let clearWaiting: (() => void) | null = null;
    const stopWaiting = () => {
      clearWaiting?.();
      clearWaiting = null;
    };
    // The attempt that finally gets through is the one that takes the waiting
    // message down — not the end of that attempt, which is after the install.
    const drainReport = supersede(stopWaiting, report);

    (async () => {
      for (let attempt = 0; !cancelled; attempt++) {
        try {
          // Two sources: `pending` (set via our on_open_url listener, which can
          // race and miss on macOS) and `current` (the plugin's own launch-URL
          // store, reliable on cold launch). Prefer whichever is present.
          let dl = await invoke<AppDeepLink | null>('get_pending_app_deep_link');
          if (!dl) dl = await invoke<AppDeepLink | null>('get_current_app_deep_link');
          if (dl) {
            const outcome = await handle(dl, drainReport);
            if (outcome !== 'retry') {
              stopWaiting(); // a no-op unless the outcome was silent
              await invoke('clear_pending_app_deep_link').catch(() => {});
              return;
            }
            // A pending link the node is not ready for yet. The backoff runs
            // to ~30s; saying nothing for that long, right after the user
            // followed an invite, is the reported complaint.
            if (!clearWaiting) {
              clearWaiting = once(report.progress(
                'Opening your link\u2014waiting for the node to finish starting\u2026',
              ));
            }
          }
        } catch (e) {
          console.warn('[deep-link] cold-start drain error:', e);
        }
        const wait = DRAIN_BACKOFF_MS[attempt];
        if (cancelled || wait === undefined) {
          // Out of attempts with a link still pending: it never opened, and
          // until now that was indistinguishable from never having clicked.
          if (clearWaiting) {
            stopWaiting();
            report.failed(
              'Could not open your link: the node did not become ready in time. Try the link again.',
            );
          }
          return;
        }
        await sleep(wait);
      }
      stopWaiting();
    })();

    return () => {
      cancelled = true;
      stopWaiting();
      unlistenPromise.then((off) => off && off()).catch(() => {});
    };
    // `toast`'s actions are identity-stable (see ToastContext), so this effect
    // still runs exactly once per `enabled` change.
  }, [enabled, toast]);
}
