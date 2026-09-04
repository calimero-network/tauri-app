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
 *
 * A hard reset is scoped by PATH, not by ownership - every node whose data dir
 * sits under a target path gets stopped and verified gone before the delete.
 */
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import {
  detectRunningMerodNodes,
  stopMerodByPid,
  deleteCalimeroDataDir,
  normalizeHomeDir,
  type RunningMerodNode,
} from './merod';
import { getSettings, clearAllAppData, DEFAULT_NODE_HOME_DIR } from './settings';
import { revokeMdmaSession } from './cloudAuth';
import { sleep, pollUntil } from './appUtils';

/** How long to wait for targeted nodes to disappear from the process scan. */
const NODE_STOP_TIMEOUT_MS = 10_000;
/** How often to re-run the process scan while waiting for that. */
const NODE_STOP_POLL_MS = 500;
/** Settle so file handles are released, and so a repopulating writer shows up. */
const FILE_HANDLE_SETTLE_MS = 500;

interface HardResetOptions {
  /** Progress text for the button label ("Stopping nodes...", "Deleting...", …). */
  onStatus?: (status: string) => void;
  /** How long to wait for targeted nodes to disappear from the process scan.
   *  Overridable so tests of the give-up path skip the real wall-clock wait. */
  stopTimeoutMs?: number;
}

interface WipeClientStateOptions {
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

/** Running nodes whose data directory sits at or under any of the given target
 *  paths, regardless of who started them; a node on an unrelated home is left alone. */
function nodesUnderPaths(
  nodes: RunningMerodNode[],
  targetPaths: string[],
  osHomeDir: string
): RunningMerodNode[] {
  const targets = targetPaths.map((p) => normalizeHomeDir(p, osHomeDir));
  return nodes.filter((n) => {
    if (!n.home_dir) return false;
    const nodeDir = `${normalizeHomeDir(n.home_dir, osHomeDir)}/${n.node_name}`;
    return targets.some((t) => nodeDir === t || nodeDir.startsWith(`${t}/`));
  });
}

/** The configured data dir plus the default, deduped: after a reset, onboarding
 *  starts from the default home regardless of what was configured. */
function targetDataDirs(): string[] {
  const settingsDataDir = getSettings().embeddedNodeDataDir || DEFAULT_NODE_HOME_DIR;
  return [...new Set([settingsDataDir, DEFAULT_NODE_HOME_DIR])];
}

function describeNode(node: RunningMerodNode): string {
  return `"${node.node_name}" (PID ${node.pid}) under ${node.home_dir}`;
}

export interface HardResetPreview {
  /** Every directory the reset will delete - always includes ~/.calimero. */
  dirsToDelete: string[];
  /** Every running node, anywhere on the machine, whose data dir sits under one of those. */
  nodesToStop: RunningMerodNode[];
}

/** What a hard reset would do, for the confirmation dialog. Read-only. */
export async function previewHardReset(): Promise<HardResetPreview> {
  const dirsToDelete = targetDataDirs();
  const osHomeDir = await homeDir();
  const nodesToStop = nodesUnderPaths(await detectRunningMerodNodes(), dirsToDelete, osHomeDir);
  return { dirsToDelete, nodesToStop };
}

/** Stop every node whose data dir sits under one of `dirs`, whoever started it - a
 *  hard reset is scoped by path, not by app ownership. Failures are not fatal here. */
async function stopNodesUnder(dirs: string[], osHomeDir: string): Promise<void> {
  const toStop = nodesUnderPaths(await detectRunningMerodNodes(), dirs, osHomeDir);
  for (const node of toStop) {
    try {
      await stopMerodByPid(node.pid);
    } catch (err) {
      console.warn(`[hardReset] failed to stop ${describeNode(node)}:`, err);
    }
  }
}

/** Wait for the process scan to stop reporting nodes under `dirs`. Throws rather than
 *  let the delete run: in-memory status is useless here, the stop already cleared it. */
async function waitForNodesGone(dirs: string[], osHomeDir: string, timeoutMs: number): Promise<void> {
  let stillRunning: RunningMerodNode[] = [];
  const gone = await pollUntil(
    async () => {
      stillRunning = nodesUnderPaths(await detectRunningMerodNodes(), dirs, osHomeDir);
      return stillRunning.length === 0;
    },
    { deadlineMs: timeoutMs, intervalMs: NODE_STOP_POLL_MS }
  );
  if (!gone) {
    throw new Error(
      `Node ${describeNode(stillRunning[0])} is still running - aborting the delete to avoid corrupting its store.`
    );
  }
}

/** Delete `dir`, then delete it again after a settle: the second call reports
 *  `deleted` only if a surviving writer has repopulated the directory. */
async function deleteAndVerifyGone(dir: string): Promise<void> {
  await deleteCalimeroDataDir(dir);
  await sleep(FILE_HANDLE_SETTLE_MS);
  if ((await deleteCalimeroDataDir(dir)).deleted) {
    throw new Error(`${dir} reappeared after being deleted - a live writer is repopulating it.`);
  }
}

/** Full reset: stop every node under a target path, delete those directories, then wipe
 *  client state. Never deletes under a live writer, and throws before wiping anything. */
export async function hardReset({
  onStatus,
  stopTimeoutMs,
}: HardResetOptions = {}): Promise<void> {
  const osHomeDir = await homeDir();
  const dirsToDelete = targetDataDirs();

  onStatus?.('Stopping nodes...');
  await stopNodesUnder(dirsToDelete, osHomeDir);

  onStatus?.('Waiting for nodes to stop...');
  await waitForNodesGone(dirsToDelete, osHomeDir, stopTimeoutMs ?? NODE_STOP_TIMEOUT_MS);
  await sleep(FILE_HANDLE_SETTLE_MS);

  onStatus?.('Deleting...');
  for (const dir of dirsToDelete) {
    // Re-checked per path: a node that started during an earlier delete would
    // otherwise have its store deleted underneath it.
    const alive = nodesUnderPaths(await detectRunningMerodNodes(), [dir], osHomeDir);
    if (alive.length > 0) {
      throw new Error(
        `Node ${describeNode(alive[0])} started under ${dir} - aborting the delete to avoid corrupting its store.`
      );
    }
    await deleteAndVerifyGone(dir);
  }

  // Only now discard the client state - including the settings that told us which
  // directories to delete. The launchers go too: their apps lived in those dirs.
  await wipeClientState({ removeLaunchers: true });
}
