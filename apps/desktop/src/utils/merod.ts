import { invoke } from '@tauri-apps/api/core';

export interface MerodHealth {
  status: number;
  healthy: boolean;
  body: string;
}

/**
 * Download and extract the merod binary from GitHub release
 */
export async function downloadMerod(): Promise<string> {
  return await invoke('download_merod');
}

/**
 * List available merod nodes
 */
export async function listMerodNodes(homeDir?: string): Promise<string[]> {
  return await invoke('list_merod_nodes', { homeDir });
}

/**
 * Start the embedded merod node
 */
export async function startMerod(serverPort?: number, swarmPort?: number, dataDir?: string, nodeName?: string, debugLogs?: boolean): Promise<string> {
  return await invoke('start_merod', { serverPort, swarmPort, dataDir, nodeName, debugLogs });
}

/**
 * Stop the embedded merod node
 */
export async function stopMerod(): Promise<string> {
  return await invoke('stop_merod');
}

/**
 * Stop a merod node by PID
 */
export async function stopMerodByPid(pid: number): Promise<string> {
  return await invoke('stop_merod_by_pid_command', { pid });
}

/**
 * Check the health of a merod node at the given URL
 */
export async function checkMerodHealth(nodeUrl: string): Promise<MerodHealth> {
  return await invoke('check_merod_health', { nodeUrl });
}

const HEALTH_POLL_INTERVAL_MS = 500;

/**
 * Poll until the node reports healthy or timeout. Use after startMerod to ensure
 * the node is actually ready before advancing to login/auth steps.
 */
export async function waitForNodeHealthy(nodeUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await checkMerodHealth(nodeUrl);
    if (health.healthy) return;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(
    'Node did not become healthy in time. The node process may have crashed—check the logs.'
  );
}

export interface RunningMerodNode {
  pid: number;
  node_name: string;
  port: number; // Server port
  swarm_port?: number; // Swarm port
  home_dir?: string; // Data directory the node runs under, parsed from its argv
}

/** Normalize a home-dir path for comparison: strips a trailing separator and
 *  expands a leading `~`, so it compares equal to merod's resolved absolute path. */
export function normalizeHomeDir(dir: string | undefined | null, osHomeDir?: string): string {
  if (!dir) return '';
  let normalized = dir.trim().replace(/[\\/]+$/, '');
  if (osHomeDir && (normalized === '~' || normalized.startsWith('~/'))) {
    normalized = osHomeDir.replace(/[\\/]+$/, '') + normalized.slice(1);
  }
  return normalized;
}

/** Whether two home-dir strings resolve to the same directory once
 *  normalized. Empty/unresolved strings never match each other. */
export function homeDirsMatch(a?: string | null, b?: string | null, osHomeDir?: string): boolean {
  const na = normalizeHomeDir(a, osHomeDir);
  const nb = normalizeHomeDir(b, osHomeDir);
  return na !== '' && na === nb;
}

/**
 * Initialize/create a new merod node.
 *
 * Since core rc.17 the admin account is minted AT INIT from these
 * credentials (the login path never mints accounts), so creating a usable
 * node requires choosing its admin username/password here. Omitting them
 * defers provisioning (`--no-admin`): the node initializes but login stays
 * disabled until an account is provisioned out of band.
 */
export async function initMerodNode(
  nodeName: string,
  homeDir?: string,
  adminUser?: string,
  adminPassword?: string,
  merodVersionId?: string
): Promise<string> {
  return await invoke('init_merod_node', { nodeName, homeDir, adminUser, adminPassword, merodVersionId });
}

/**
 * Detect running merod nodes on the system
 */
export async function detectRunningMerodNodes(): Promise<RunningMerodNode[]> {
  return await invoke('detect_running_merod_nodes');
}

/**
 * Get merod logs for a node. Only available for nodes started by the app.
 */
export async function getMerodLogs(
  nodeName: string,
  homeDir?: string,
  lines?: number
): Promise<string> {
  return await invoke('get_merod_logs', { nodeName, homeDir, lines });
}

/**
 * Truncate the active log file and delete rotated segments for a node.
 */
export async function clearMerodLogs(
  nodeName: string,
  homeDir?: string
): Promise<string> {
  return await invoke('clear_merod_logs', { nodeName, homeDir });
}

export interface ExportedLogs {
  /** Absolute path the user chose in the save dialog. */
  path: string;
  /** Bytes written, including the per-segment banner lines. */
  bytes: number;
}

/**
 * Save a node's full retained log history (active file + all rotated segments)
 * to a .txt file the user picks. Resolves to null if the save dialog was
 * cancelled. Unlike getMerodLogs, this is the whole history, not a tail.
 */
export async function exportMerodLogs(
  nodeName: string,
  homeDir?: string,
  defaultFileName?: string
): Promise<ExportedLogs | null> {
  return await invoke('export_merod_logs', { nodeName, homeDir, defaultFileName });
}

/** Whether the delete removed anything, so callers never read prose to decide. */
export interface DeleteOutcome {
  deleted: boolean;
  path: string;
}

/** Total nuke; the path must be under the user's home directory. */
export async function deleteCalimeroDataDir(dataDir: string): Promise<DeleteOutcome> {
  return await invoke('delete_calimero_data_dir', { dataDir });
}

/**
 * Get the version string of the bundled merod binary by running `merod --version`.
 */
export async function getMerodBinaryVersion(): Promise<string> {
  return await invoke('get_merod_binary_version');
}

export interface MerodUpdateResult {
  replaced: boolean;
  expected_version: string;
  current_version: string;
  message: string;
}

/**
 * Download the merod binary matching the build-time MEROD_CONFIG_VERSION from
 * GitHub, replace the bundled binary, and verify the version.
 * Throws if the version after replacement does not match.
 */
export async function downloadAndReplaceMerod(): Promise<MerodUpdateResult> {
  return await invoke('download_and_replace_merod');
}
