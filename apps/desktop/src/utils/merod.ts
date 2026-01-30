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
