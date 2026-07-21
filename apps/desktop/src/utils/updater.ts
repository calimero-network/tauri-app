/**
 * Tauri Updater Utilities
 * Handles checking for updates and installing them
 */

import { stopMerod, killAllMerodProcesses, downloadAndReplaceMerod } from './merod';

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
  info?: UpdateInfo;
  error?: string;
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!isTauri()) {
    return { available: false, error: 'Not running in Tauri environment' };
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      return {
        available: true,
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
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Full update sequence:
 *   1. Stop the embedded merod node (graceful + force-kill)
 *   2. Download the correct merod binary from GitHub and replace the bundled one
 *   3. Verify the binary version matches the build-time config
 *   4. Install the Tauri app update (new frontend + Rust shell)
 *   5. Relaunch
 *
 * @param onStatus  Optional callback receiving a human-readable status string at each step.
 */
export async function installUpdate(onStatus: (status: string) => void = () => {}): Promise<void> {
  if (!isTauri()) {
    throw new Error('Not running in Tauri environment');
  }

  // 1. Stop node
  onStatus('Stopping nodes...');
  try { await stopMerod(); } catch (e) { console.warn('[updater] stopMerod failed (node may not be running):', e); }
  try { await killAllMerodProcesses(); } catch (e) { console.warn('[updater] killAllMerodProcesses failed:', e); }

  // 2. Download + replace merod binary
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

  // 3. Install Tauri app update (new shell / frontend bundle).
  // v2's plugin-updater installs via the Update handle returned by check(),
  // so re-resolve it here before downloading + installing.
  onStatus('Installing app update...');
  const { check } = await import('@tauri-apps/plugin-updater');
  const { relaunch } = await import('@tauri-apps/plugin-process');
  const update = await check();
  if (!update) {
    throw new Error('No update available to install');
  }
  await update.downloadAndInstall();

  // 4. Relaunch — app closes and reopens with the new binary
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
