/**
 * Tauri Updater Utilities
 * Handles checking for updates and installing them
 */

import type { Update, DownloadEvent } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { stopMerod, downloadAndReplaceMerod } from './merod';
import { compareSemverDesc } from './registry';

/** How often a running app re-checks latest.json. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** First check after launch — late enough not to compete with node startup. */
export const STARTUP_CHECK_DELAY_MS = 5_000;
/** Event the tray's "Check for Updates…" item emits to the main window. */
export const TRAY_CHECK_EVENT = 'tray-check-for-updates';

// The Update handle from the most recent checkForUpdates(). installUpdate()
// reuses it instead of calling check() a second time — avoiding an extra network
// round-trip and a race where the second check could disagree with (or fail to
// re-find) the update already shown to the user.
let pendingUpdate: Update | null = null;
// A check already on the wire. The background schedule, the tray and the
// Settings button can all ask at once; they share one request (and one Update
// handle) instead of racing each other.
let inFlightCheck: Promise<UpdateStatus> | null = null;

export function isTauri(): boolean {
  // Tauri v2 injects __TAURI_INTERNALS__ into every webview regardless of the
  // withGlobalTauri setting (which is false here), so __TAURI__ is unreliable.
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface UpdateInfo {
  version: string;
  date: string;
  body: string;
}

export interface UpdateStatus {
  available: boolean;
  /** Not running inside Tauri (plain browser / e2e) — there is nothing to check. */
  unsupported?: boolean;
  info?: UpdateInfo;
  /** The installed version is below the manifest's minimumVersion — the update cannot be deferred. */
  mandatory?: boolean;
  error?: string;
}

/**
 * True when the running version is below the `minimumVersion` declared in latest.json.
 * The plugin hands us the whole manifest as `rawJson`, so reading our own custom
 * field costs no extra request. A missing or malformed field never blocks anyone.
 */
function isBelowMinimum(update: Update): boolean {
  const minimum = update.rawJson?.minimumVersion;
  if (typeof minimum !== 'string' || minimum === '') {
    return false;
  }
  return compareSemverDesc(update.currentVersion, minimum) > 0;
}

export function checkForUpdates(): Promise<UpdateStatus> {
  if (!inFlightCheck) {
    inFlightCheck = runCheck().finally(() => {
      inFlightCheck = null;
    });
  }
  return inFlightCheck;
}

async function runCheck(): Promise<UpdateStatus> {
  if (!isTauri()) {
    return { available: false, unsupported: true, error: 'Not running in Tauri environment' };
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    // Every check() allocates a Rust-side resource; release the one it replaces
    // so an hourly check does not leak a handle per hour.
    if (pendingUpdate && pendingUpdate !== update) {
      pendingUpdate.close().catch(() => {});
    }
    pendingUpdate = update;
    if (update) {
      return {
        available: true,
        mandatory: isBelowMinimum(update),
        info: {
          version: update.version,
          date: update.date || new Date().toISOString(),
          body: update.body || 'A new version is available.',
        },
      };
    }
    return { available: false };
  } catch (error) {
    console.error('Failed to check for updates:', error);
    return {
      available: false,
      // The plugin rejects with a plain string, not an Error — keep its text,
      // it is the only clue to what failed (offline, 404, bad signature, ...).
      error: describeError(error),
    };
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error !== '') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'Unknown error';
}

export type UpdateCheckTrigger = 'startup' | 'interval' | 'focus';

interface FocusTarget {
  addEventListener(type: 'focus', listener: () => void): void;
  removeEventListener(type: 'focus', listener: () => void): void;
}

interface ScheduleOptions {
  intervalMs?: number;
  startupDelayMs?: number;
  /** Where to listen for focus; defaults to the window. */
  focusTarget?: FocusTarget | null;
  now?: () => number;
}

/**
 * Checks shortly after launch, then every `intervalMs`, and again whenever the
 * window regains focus after a check has gone stale. The focus re-check covers a
 * main window that sits hidden for days (closing it only hides it, and apps are
 * usually opened straight from their launchers), where the OS may throttle the
 * interval timer. Returns a function that stops everything.
 */
export function startUpdateChecks(
  onResult: (status: UpdateStatus, trigger: UpdateCheckTrigger) => void,
  options: ScheduleOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const focusTarget =
    options.focusTarget !== undefined
      ? options.focusTarget
      : typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        ? window
        : null;

  let stopped = false;
  let lastCheckAt = 0;

  const run = async (trigger: UpdateCheckTrigger) => {
    lastCheckAt = now();
    const status = await checkForUpdates();
    if (!stopped) onResult(status, trigger);
  };

  const startup = setTimeout(() => run('startup'), options.startupDelayMs ?? STARTUP_CHECK_DELAY_MS);
  const interval = setInterval(() => run('interval'), intervalMs);
  const onFocus = () => {
    if (lastCheckAt !== 0 && now() - lastCheckAt >= intervalMs) {
      run('focus');
    }
  };
  focusTarget?.addEventListener('focus', onFocus);

  return () => {
    stopped = true;
    clearTimeout(startup);
    clearInterval(interval);
    focusTarget?.removeEventListener('focus', onFocus);
  };
}

/**
 * Mirrors a check's outcome into the tray menu — the only UI left while the main
 * window is hidden. Best effort: a tray that cannot be updated must never break
 * the check that produced the result.
 */
export async function reflectUpdateInTray(status: UpdateStatus): Promise<void> {
  if (!isTauri() || status.unsupported) return;
  const state = status.available ? 'available' : status.error ? 'failed' : 'current';
  try {
    await invoke('set_update_menu_state', { state, version: status.info?.version ?? null });
  } catch (e) {
    console.warn('[updater] could not update the tray menu:', e);
  }
}

/** Turns plugin download events into a "Downloading update... 42%" status line. */
export function downloadProgressReporter(onStatus: (status: string) => void): (event: DownloadEvent) => void {
  let total = 0;
  let received = 0;
  let lastPercent = -1;
  return (event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
      onStatus('Downloading update...');
    } else if (event.event === 'Progress') {
      received += event.data.chunkLength;
      if (total > 0) {
        const percent = Math.min(100, Math.floor((received / total) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          onStatus(`Downloading update... ${percent}%`);
        }
      }
    }
  };
}

/**
 * Full update sequence:
 *   1. Download (and signature-verify) the app update. Nothing is touched yet,
 *      so a failed or offline download leaves the running node alone.
 *   2. Stop this app's own tracked node(s) - never a machine-wide kill, which
 *      would also tear down an unrelated node someone else is running.
 *   3. Download the correct merod binary from GitHub and replace the bundled one
 *   4. Verify the binary version matches the build-time config
 *   5. Install the downloaded app update (new frontend + Rust shell)
 *   6. Relaunch
 *
 * @param onStatus  Optional callback receiving a human-readable status string at each step.
 */
export async function installUpdate(onStatus: (status: string) => void = () => {}): Promise<void> {
  if (!isTauri()) {
    throw new Error('Not running in Tauri environment');
  }

  // Reuse the handle from the preceding checkForUpdates() when available;
  // only re-check if installUpdate() was somehow called without one.
  let update = pendingUpdate;
  if (!update) {
    const { check } = await import('@tauri-apps/plugin-updater');
    update = await check();
  }
  if (!update) {
    throw new Error('No update available to install');
  }

  // 1. Download first: the plugin verifies the signature here.
  onStatus('Downloading update...');
  await update.download(downloadProgressReporter(onStatus));

  // 2. Stop node - stopMerod() only ever touches this app's own tracked node(s).
  onStatus('Stopping nodes...');
  try { await stopMerod(); } catch (e) { console.warn('[updater] stopMerod failed (node may not be running):', e); }

  // 3. Download + replace merod binary
  onStatus('Downloading merod binary...');
  try {
    const merodResult = await downloadAndReplaceMerod();
    if (merodResult.replaced) {
      console.info('[updater] merod binary updated to', merodResult.current_version);
    } else {
      console.info('[updater] merod binary already at correct version:', merodResult.current_version);
    }
  } catch (e) {
    // Tauri invoke() rejects with a serialized error object {message, code}, not a JS Error instance.
    const msg = e instanceof Error
      ? e.message
      : (e && typeof e === 'object' && typeof (e as any).message === 'string'
          ? (e as any).message
          : String(e));
    if (msg.includes('Version mismatch after replace')) {
      throw e;
    }
    console.warn('[updater] merod download/replace failed (proceeding with app update):', msg);
  }

  // 4. Install the already-downloaded app update (new shell / frontend bundle).
  onStatus('Installing app update...');
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await update.install();
  pendingUpdate = null;

  // 5. Relaunch — app closes and reopens with the new binary
  onStatus('Restarting...');
  await relaunch();
}

export async function getCurrentVersion(): Promise<string> {
  if (!isTauri()) {
    return '0.0.0-dev';
  }
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch (error) {
    console.error('Failed to get app version:', error);
    return 'unknown';
  }
}
