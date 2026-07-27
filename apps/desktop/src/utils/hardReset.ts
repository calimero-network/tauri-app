/**
 * The one implementation of "total nuke": delete everything this desktop owns and
 * come back up as a fresh install.
 *
 * Settings and Onboarding used to carry their own copies of this sequence, which
 * had already drifted (only one of them cleared sessionStorage) and both stopped
 * at the merod data directory. Deleting that directory is only half a reset —
 * the session lives outside it:
 *
 * - Every app frontend runs in its own web origin, so the access token handed to
 *   it in the SSO hash is persisted by its own MeroJs, in the webview's on-disk
 *   website-data store. The desktop's `localStorage.clear()` cannot touch another
 *   origin's silo, so reopening an app after a "reset" resumed the old session.
 *   Clearing that store is what `clear_app_sessions` does natively.
 * - The Cloud session is a server-side 7-day session; dropping our copy of the
 *   token leaves it alive and replayable until it expires.
 * - Per-app launchers keep working (and keep getting tokens brokered) off a
 *   capability store that outlives the data directory — `remove_app_launchers`.
 */
import { invoke } from '@tauri-apps/api/core';
import {
  stopMerod,
  killAllMerodProcesses,
  getMerodStatus,
  deleteCalimeroDataDir,
} from './merod';
import { getSettings, clearAllAppData } from './settings';
import { revokeMdmaSession } from './cloudAuth';

const DEFAULT_DATA_DIR = '~/.calimero';

/** How long to wait for the embedded node to report stopped before moving on. */
const NODE_STOP_TIMEOUT_MS = 10_000;
const NODE_STOP_POLL_MS = 500;
/** OS-level settle so merod's file handles are released before the delete. */
const FILE_HANDLE_SETTLE_MS = 500;

export interface HardResetOptions {
  /** Progress text for the button label ("Stopping nodes...", "Deleting...", …). */
  onStatus?: (status: string) => void;
}

export interface WipeClientStateOptions {
  /**
   * Also delete the per-app launchers, their capability store and the extracted
   * shell binary. Total-nuke only — a launcher is a dock icon the user placed,
   * so the softer "reset settings" leaves them in place.
   */
  removeLaunchers?: boolean;
}

/**
 * Wipe client-side state: the Cloud session, this origin's storage, and every app
 * session (open app windows, running launcher shells, and the webview's on-disk
 * website data for all app origins).
 *
 * Best-effort and never throws — it also runs on the failure path of
 * `hardReset()`, where the point is to reset as much as possible. Returns false
 * if a native step failed, which means app sessions may have survived.
 */
export async function wipeClientState({
  removeLaunchers = false,
}: WipeClientStateOptions = {}): Promise<boolean> {
  // Revoke the Cloud session while we still hold the token to address it with.
  // Fire-and-forget by design; see revokeMdmaSession.
  try {
    revokeMdmaSession(getSettings().cloudIdToken);
  } catch (err) {
    console.warn('[hardReset] cloud session revocation failed:', err);
  }

  clearAllAppData();

  let ok = true;
  // Sessions first: this kills the shells that run out of the launcher bundles.
  try {
    await invoke<string>('clear_app_sessions');
  } catch (err) {
    console.error('[hardReset] clear_app_sessions failed:', err);
    ok = false;
  }
  if (removeLaunchers) {
    try {
      await invoke<string>('remove_app_launchers');
    } catch (err) {
      console.error('[hardReset] remove_app_launchers failed:', err);
      ok = false;
    }
  }
  return ok;
}

/**
 * Full reset: stop and kill every node, delete the data directories, then wipe
 * all client state. The caller reloads the window afterwards.
 *
 * Throws if a data directory could not be deleted, *before* any client state is
 * touched — a half-deleted node plus a fresh-looking app is worse than a clean
 * failure the user can retry. On that path the caller may still call
 * `wipeClientState()` explicitly. Failing to stop a node is not fatal: the
 * delete that follows is the real test, and it reports its own failure.
 */
export async function hardReset({ onStatus }: HardResetOptions = {}): Promise<void> {
  // 1. Graceful stop of the embedded node.
  onStatus?.('Stopping nodes...');
  try {
    await stopMerod();
  } catch {
    // not running — ok
  }

  // 2. Force-kill any remaining merod process, so nothing holds the data dir open.
  try {
    await killAllMerodProcesses();
  } catch (err) {
    console.warn('[hardReset] killAllMerodProcesses failed, continuing:', err);
  }

  // 3. Wait until the embedded node actually reports stopped.
  onStatus?.('Waiting for nodes to stop...');
  const deadline = Date.now() + NODE_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const status = await getMerodStatus();
      if (!status.running) break;
    } catch {
      break; // process gone — treat as stopped
    }
    await new Promise((r) => setTimeout(r, NODE_STOP_POLL_MS));
  }
  await new Promise((r) => setTimeout(r, FILE_HANDLE_SETTLE_MS));

  // 4. Delete the configured data dir AND the default one: after the reset,
  //    onboarding starts from ~/.calimero regardless of what was configured.
  onStatus?.('Deleting...');
  const settingsDataDir = getSettings().embeddedNodeDataDir || DEFAULT_DATA_DIR;
  const dirsToDelete = [...new Set([settingsDataDir, DEFAULT_DATA_DIR])];
  for (const dir of dirsToDelete) {
    await deleteCalimeroDataDir(dir);
  }

  // 5. Only now discard the client state — including the settings that told us
  //    which directories to delete. The launchers go too: the apps they point at
  //    lived in the data directory we just deleted.
  await wipeClientState({ removeLaunchers: true });
}
