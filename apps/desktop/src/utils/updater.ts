/**
 * Tauri Updater Utilities
 * Handles checking for updates and installing them
 */

import { stopMerod, killAllMerodProcesses, downloadAndReplaceMerod } from './merod';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
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
    const { checkUpdate } = await import('@tauri-apps/api/updater');
    const { shouldUpdate, manifest } = await checkUpdate();
    if (shouldUpdate && manifest) {
      return {
        available: true,
        info: {
          version: manifest.version,
          date: manifest.date || new Date().toISOString(),
          body: manifest.body || 'A new version is available.',
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
  const result = await downloadAndReplaceMerod();
  if (result.replaced) {
    onStatus(`Verified merod ${result.current_version}`);
  }

  // 3. Install Tauri app update (new shell / frontend bundle)
  onStatus('Installing app update...');
  const { installUpdate: tauriInstallUpdate } = await import('@tauri-apps/api/updater');
  const { relaunch } = await import('@tauri-apps/api/process');
  await tauriInstallUpdate();

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
