/**
 * Tauri Updater Utilities
 * Handles checking for updates and installing them
 */

// Check if we're running in Tauri
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
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

/**
 * Check for available updates
 * Returns update info if an update is available
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!isTauri()) {
    return { available: false, error: "Not running in Tauri environment" };
  }

  try {
    // Dynamic import to avoid issues in non-Tauri environments
    const { checkUpdate } = await import("@tauri-apps/api/updater");
    const { shouldUpdate, manifest } = await checkUpdate();

    if (shouldUpdate && manifest) {
      return {
        available: true,
        info: {
          version: manifest.version,
          date: manifest.date || new Date().toISOString(),
          body: manifest.body || "A new version is available.",
        },
      };
    }

    return { available: false };
  } catch (error) {
    console.error("Failed to check for updates:", error);
    return {
      available: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Install the available update
 * This will download and install the update, then restart the app
 */
export async function installUpdate(): Promise<void> {
  if (!isTauri()) {
    throw new Error("Not running in Tauri environment");
  }

  try {
    const { installUpdate: tauriInstallUpdate } = await import(
      "@tauri-apps/api/updater"
    );
    const { relaunch } = await import("@tauri-apps/api/process");

    // Install the update
    await tauriInstallUpdate();

    // Relaunch the app to apply the update
    await relaunch();
  } catch (error) {
    console.error("Failed to install update:", error);
    throw error;
  }
}

/**
 * Get the current app version
 */
export async function getCurrentVersion(): Promise<string> {
  if (!isTauri()) {
    return "0.0.0-dev";
  }

  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch (error) {
    console.error("Failed to get app version:", error);
    return "unknown";
  }
}
