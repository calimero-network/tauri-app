// Admin API Types - Generated from OpenAPI 3.0.3 specification

// Re-export shared types
export { ApiResponse } from '../http-client';

// Health and Status Types
export interface HealthStatus {
  status: string;
}

export interface AdminAuthStatus {
  status: string;
}

// Application Types
export interface InstallApplicationRequest {
  url: string;
  hash?: string;
  metadata: number[]; // Array of bytes (Vec<u8> in Rust)
}

export interface InstallDevApplicationRequest {
  path: string;
  metadata: string; // base64 encoded
}

export interface InstallApplicationResponse {
  applicationId: string;
}

export interface UninstallApplicationResponse {
  applicationId: string;
}

export interface Application {
  id: string;
  name: string;
  version: string;
  metadata: string; // base64 encoded
}

export interface ListApplicationsResponse {
  apps: Application[];
}

export interface GetApplicationResponse {
  application: Application;
}

// Context Types
export interface CreateContextRequest {
  name: string;
  description?: string;
  metadata?: Record<string, any>;
}

export interface CreateContextResponse {
  contextId: string;
}

export interface DeleteContextResponse {
  contextId: string;
}

export interface Context {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface ListContextsResponse {
  contexts: Context[];
}

export interface GetContextResponse {
  context: Context;
}

// Blob Types
export interface UploadBlobRequest {
  data: string; // base64 encoded
  metadata?: Record<string, any>;
}

export interface UploadBlobResponse {
  blobId: string;
}

export interface DeleteBlobResponse {
  blobId: string;
}

export interface Blob {
  id: string;
  size: number;
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface ListBlobsResponse {
  blobs: Blob[];
}

export interface GetBlobResponse {
  blob: Blob;
}

// Alias Types
export interface CreateAliasRequest {
  name: string;
  target: string;
  description?: string;
}

export interface CreateAliasResponse {
  aliasId: string;
}

export interface DeleteAliasResponse {
  aliasId: string;
}

export interface Alias {
  id: string;
  name: string;
  target: string;
  description?: string;
  createdAt: string;
}

export interface ListAliasesResponse {
  aliases: Alias[];
}

export interface GetAliasResponse {
  alias: Alias;
}

// Network Types
export interface Peer {
  id: string;
  address: string;
  status: string;
  lastSeen: string;
}

export interface GetNetworkPeersResponse {
  peers: Peer[];
}

export interface GetNetworkStatsResponse {
  totalPeers: number;
  connectedPeers: number;
  disconnectedPeers: number;
  averageLatency: number;
}

export interface NetworkConfig {
  maxPeers: number;
  minPeers: number;
  peerDiscovery: boolean;
  bootstrapNodes: string[];
}

export interface GetNetworkConfigResponse {
  config: NetworkConfig;
}

export interface UpdateNetworkConfigRequest {
  maxPeers?: number;
  minPeers?: number;
  peerDiscovery?: boolean;
  bootstrapNodes?: string[];
}

export interface UpdateNetworkConfigResponse {
  success: boolean;
  message: string;
}

// System Types
export interface SystemInfo {
  version: string;
  platform: string;
  architecture: string;
  uptime: number;
  memory: {
    total: number;
    used: number;
    free: number;
  };
  cpu: {
    cores: number;
    usage: number;
  };
}

export interface GetSystemInfoResponse {
  info: SystemInfo;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  source: string;
}

export interface GetSystemLogsResponse {
  logs: LogEntry[];
}

export interface SystemMetrics {
  cpu: {
    usage: number;
    cores: number;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usage: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    usage: number;
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
  };
}

export interface GetSystemMetricsResponse {
  metrics: SystemMetrics;
}

export interface RestartSystemResponse {
  success: boolean;
  message: string;
}

export interface ShutdownSystemResponse {
  success: boolean;
  message: string;
}

// Client Configuration
export interface AdminApiClientConfig {
  baseUrl: string;
  getAuthToken?: () => Promise<string | undefined>;
  timeoutMs?: number;
}
