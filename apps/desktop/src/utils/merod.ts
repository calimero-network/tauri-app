import { invoke } from '@tauri-apps/api/tauri';

export interface MerodStatus {
  running: boolean;
  exit_code?: number;
}

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
export async function startMerod(serverPort?: number, swarmPort?: number, dataDir?: string, nodeName?: string): Promise<string> {
  return await invoke('start_merod', { serverPort, swarmPort, dataDir, nodeName });
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
 * Get the current status of the embedded merod node
 */
export async function getMerodStatus(): Promise<MerodStatus> {
  return await invoke('get_merod_status');
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
}

/**
 * Initialize/create a new merod node
 */
export async function initMerodNode(nodeName: string, homeDir?: string): Promise<string> {
  return await invoke('init_merod_node', { nodeName, homeDir });
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
 * Kill all merod processes on the system. Call before total nuke.
 */
export async function killAllMerodProcesses(): Promise<string> {
  return await invoke('kill_all_merod_processes');
}

/**
 * Delete the Calimero data directory and all its contents (total nuke).
 * Path must be under the user's home directory.
 * Call killAllMerodProcesses() first.
 */
export async function deleteCalimeroDataDir(dataDir: string): Promise<string> {
  return await invoke('delete_calimero_data_dir', { dataDir });
}
