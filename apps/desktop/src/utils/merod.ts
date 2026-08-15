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

export interface RestartOutcome {
  restarted: boolean;
  /** null when the node started but the app could not re-confirm which pid it is. */
  pid: number | null;
}

/**
 * Restart the embedded merod node, stopping it first if already running.
 */
export async function restartMerod(serverPort?: number, swarmPort?: number, dataDir?: string, nodeName?: string, debugLogs?: boolean, allowUnowned?: boolean): Promise<RestartOutcome> {
  return await invoke('restart_merod', { serverPort, swarmPort, dataDir, nodeName, debugLogs, allowUnowned });
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
    'Node did not become healthy in time. The node process may have crashed - check the logs.'
  );
}

const RESTART_READY_POLL_INTERVAL_MS = 250;
const RESTART_READY_DEADLINE_MS = 15000;

/** Poll a health check until the node answers, up to a deadline. A 401 means the
 *  node is up but unauthenticated, so it counts as ready rather than a failure. */
export async function pollUntilNodeReady(
  healthCheck: () => Promise<{ error?: { code?: string } }>,
  deadlineMs = RESTART_READY_DEADLINE_MS,
  intervalMs = RESTART_READY_POLL_INTERVAL_MS
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const result = await healthCheck().catch(() => ({ error: { code: undefined as string | undefined } }));
    if (!result.error || result.error.code === '401') return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export interface RunningMerodNode {
  pid: number;
  node_name: string;
  port: number; // Server port
  swarm_port?: number; // Swarm port
  home_dir?: string; // Data directory the node runs under, parsed from its argv
  exe?: string; // Executable path the running node was launched from
  owned?: boolean; // Whether this app started it
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

/** The running node under `homeDir`, narrowed to `nodeName` when one is given. A name
 *  alone is ambiguous: one home holds several nodes, and another home can repeat a name. */
export function findRunningNode(
  nodes: RunningMerodNode[],
  homeDir: string,
  nodeName: string,
  osHomeDir?: string
): RunningMerodNode | undefined {
  const target = normalizeHomeDir(homeDir, osHomeDir);
  // Neither an unresolved home nor an unnamed node identifies one: `~/.calimero`
  // is merod's own default, so the home alone can match several nodes.
  if (!target || !nodeName) return undefined;
  return nodes.find(
    (n) => normalizeHomeDir(n.home_dir, osHomeDir) === target && n.node_name === nodeName
  );
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
 * Detect running merod nodes on the system. Always an array: a stubbed or
 * unavailable command resolves to null, which every caller used to re-check.
 */
export async function detectRunningMerodNodes(): Promise<RunningMerodNode[]> {
  const nodes = await invoke<RunningMerodNode[] | null>('detect_running_merod_nodes');
  return Array.isArray(nodes) ? nodes : [];
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
