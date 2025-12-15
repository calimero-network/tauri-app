import { HttpClient } from '../http-client';
import {
  // Common types
  ApiResponse,
  // Health and Status
  HealthStatus,
  AdminAuthStatus,

  // Applications
  InstallApplicationRequest,
  InstallDevApplicationRequest,
  InstallApplicationResponse,
  UninstallApplicationResponse,
  ListApplicationsResponse,
  GetApplicationResponse,

  // Contexts
  CreateContextRequest,
  CreateContextResponse,
  DeleteContextResponse,
  ListContextsResponse,
  GetContextResponse,

  // Blobs
  UploadBlobRequest,
  UploadBlobResponse,
  DeleteBlobResponse,
  ListBlobsResponse,
  GetBlobResponse,

  // Aliases
  CreateAliasRequest,
  CreateAliasResponse,
  DeleteAliasResponse,
  ListAliasesResponse,
  GetAliasResponse,

  // Network
  GetNetworkPeersResponse,
  GetNetworkStatsResponse,
  GetNetworkConfigResponse,
  UpdateNetworkConfigRequest,
  UpdateNetworkConfigResponse,

  // System
  GetSystemInfoResponse,
  GetSystemLogsResponse,
  GetSystemMetricsResponse,
  RestartSystemResponse,
  ShutdownSystemResponse,
} from './admin-types';

export class AdminApiClient {
  constructor(private httpClient: HttpClient) {}

  // Health and Status Endpoints
  async healthCheck(): Promise<HealthStatus> {
    const response =
      await this.httpClient.get<ApiResponse<HealthStatus>>('/health');
    if (!response.data) {
      throw new Error('Health response data is null');
    }
    return response.data;
  }

  async isAuthed(): Promise<AdminAuthStatus> {
    return this.httpClient.get<AdminAuthStatus>('/is-authed');
  }

  // Application Management Endpoints
  async installApplication(
    request: InstallApplicationRequest,
  ): Promise<InstallApplicationResponse> {
    return this.httpClient.post<InstallApplicationResponse>(
      '/applications',
      request,
    );
  }

  async installDevApplication(
    request: InstallDevApplicationRequest,
  ): Promise<InstallApplicationResponse> {
    return this.httpClient.post<InstallApplicationResponse>(
      '/applications/dev',
      request,
    );
  }

  async uninstallApplication(
    appId: string,
  ): Promise<UninstallApplicationResponse> {
    return this.httpClient.delete<UninstallApplicationResponse>(
      `/applications/${appId}`,
    );
  }

  async listApplications(): Promise<ListApplicationsResponse> {
    return this.httpClient.get<ListApplicationsResponse>('/applications');
  }

  async getApplication(appId: string): Promise<GetApplicationResponse> {
    return this.httpClient.get<GetApplicationResponse>(
      `/applications/${appId}`,
    );
  }

  // Context Management Endpoints
  async createContext(
    request: CreateContextRequest,
  ): Promise<CreateContextResponse> {
    return this.httpClient.post<CreateContextResponse>('/contexts', request);
  }

  async deleteContext(contextId: string): Promise<DeleteContextResponse> {
    return this.httpClient.delete<DeleteContextResponse>(
      `/contexts/${contextId}`,
    );
  }

  async getContexts(): Promise<ListContextsResponse> {
    return this.httpClient.get<ListContextsResponse>('/contexts');
  }

  async getContext(contextId: string): Promise<GetContextResponse> {
    return this.httpClient.get<GetContextResponse>(`/contexts/${contextId}`);
  }

  // Blob Management Endpoints
  async uploadBlob(request: UploadBlobRequest): Promise<UploadBlobResponse> {
    return this.httpClient.post<UploadBlobResponse>('/blobs', request);
  }

  async deleteBlob(blobId: string): Promise<DeleteBlobResponse> {
    return this.httpClient.delete<DeleteBlobResponse>(`/blobs/${blobId}`);
  }

  async listBlobs(): Promise<ListBlobsResponse> {
    return this.httpClient.get<ListBlobsResponse>('/blobs');
  }

  async getBlob(blobId: string): Promise<GetBlobResponse> {
    return this.httpClient.get<GetBlobResponse>(`/blobs/${blobId}`);
  }

  // Alias Management Endpoints
  async createAlias(request: CreateAliasRequest): Promise<CreateAliasResponse> {
    return this.httpClient.post<CreateAliasResponse>('/alias', request);
  }

  async deleteAlias(aliasId: string): Promise<DeleteAliasResponse> {
    return this.httpClient.delete<DeleteAliasResponse>(`/alias/${aliasId}`);
  }

  async listAliases(): Promise<ListAliasesResponse> {
    return this.httpClient.get<ListAliasesResponse>('/alias');
  }

  async getAlias(aliasId: string): Promise<GetAliasResponse> {
    return this.httpClient.get<GetAliasResponse>(`/alias/${aliasId}`);
  }

  // Network Management Endpoints
  async getNetworkPeers(): Promise<GetNetworkPeersResponse> {
    return this.httpClient.get<GetNetworkPeersResponse>('/network/peers');
  }

  async getNetworkStats(): Promise<GetNetworkStatsResponse> {
    return this.httpClient.get<GetNetworkStatsResponse>('/network/stats');
  }

  async getNetworkConfig(): Promise<GetNetworkConfigResponse> {
    return this.httpClient.get<GetNetworkConfigResponse>('/network/config');
  }

  async updateNetworkConfig(
    request: UpdateNetworkConfigRequest,
  ): Promise<UpdateNetworkConfigResponse> {
    return this.httpClient.put<UpdateNetworkConfigResponse>(
      '/network/config',
      request,
    );
  }

  async getPeersCount(): Promise<{ count: number }> {
    return this.httpClient.get<{ count: number }>('/network/peers/count');
  }

  // System Management Endpoints
  async getSystemInfo(): Promise<GetSystemInfoResponse> {
    return this.httpClient.get<GetSystemInfoResponse>('/system/info');
  }

  async getSystemLogs(): Promise<GetSystemLogsResponse> {
    return this.httpClient.get<GetSystemLogsResponse>('/system/logs');
  }

  async getSystemMetrics(): Promise<GetSystemMetricsResponse> {
    return this.httpClient.get<GetSystemMetricsResponse>('/system/metrics');
  }

  async restartSystem(): Promise<RestartSystemResponse> {
    return this.httpClient.post<RestartSystemResponse>('/system/restart');
  }

  async shutdownSystem(): Promise<ShutdownSystemResponse> {
    return this.httpClient.post<ShutdownSystemResponse>('/system/shutdown');
  }
}
