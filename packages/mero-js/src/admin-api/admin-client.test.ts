import { describe, it, expect, beforeEach } from 'vitest';
import { AdminApiClient } from './admin-client';
import {
  HealthStatus,
  AdminAuthStatus,
  CreateContextRequest,
  CreateContextResponse,
  ListContextsResponse,
  GetContextResponse,
  DeleteContextResponse,
  UploadBlobRequest,
  UploadBlobResponse,
  ListBlobsResponse,
  GetBlobResponse,
  DeleteBlobResponse,
  CreateAliasRequest,
  CreateAliasResponse,
  ListAliasesResponse,
  GetAliasResponse,
  DeleteAliasResponse,
  GetNetworkPeersResponse,
  GetNetworkStatsResponse,
  GetNetworkConfigResponse,
  UpdateNetworkConfigRequest,
  UpdateNetworkConfigResponse,
  GetSystemInfoResponse,
  GetSystemLogsResponse,
  GetSystemMetricsResponse,
  RestartSystemResponse,
  ShutdownSystemResponse,
  InstallApplicationRequest,
  InstallApplicationResponse,
  InstallDevApplicationRequest,
  UninstallApplicationResponse,
  ListApplicationsResponse,
  GetApplicationResponse,
} from './admin-types';
import { HttpClient } from '../http-client';

// Mock HttpClient for unit tests
class MockHttpClient implements HttpClient {
  private mockResponses = new Map<string, any>();

  setMockResponse(method: string, path: string, response: any) {
    this.mockResponses.set(`${method} ${path}`, response);
  }

  async get<T>(path: string): Promise<T> {
    const key = `GET ${path}`;
    const response = this.mockResponses.get(key);
    if (!response) {
      throw new Error(`No mock response for GET ${path}`);
    }
    return response;
  }

  async post<T>(path: string, _body: any): Promise<T> {
    const key = `POST ${path}`;
    const response = this.mockResponses.get(key);
    if (!response) {
      throw new Error(`No mock response for POST ${path}`);
    }
    return response;
  }

  async put<T>(path: string, _body: any): Promise<T> {
    const key = `PUT ${path}`;
    const response = this.mockResponses.get(key);
    if (!response) {
      throw new Error(`No mock response for PUT ${path}`);
    }
    return response;
  }

  async delete<T>(path: string): Promise<T> {
    const key = `DELETE ${path}`;
    const response = this.mockResponses.get(key);
    if (!response) {
      throw new Error(`No mock response for DELETE ${path}`);
    }
    return response;
  }

  async patch<T>(path: string, _body: any): Promise<T> {
    const key = `PATCH ${path}`;
    const response = this.mockResponses.get(key);
    if (!response) {
      throw new Error(`No mock response for PATCH ${path}`);
    }
    return response;
  }

  async head<T>(path: string): Promise<T> {
    const key = `HEAD ${path}`;
    const response = this.mockResponses.get(key);
    if (!response) {
      throw new Error(`No mock response for HEAD ${path}`);
    }
    return response;
  }

  async request<T>(_options: any): Promise<T> {
    throw new Error('Mock request method not implemented');
  }
}

describe('AdminApiClient', () => {
  let mockHttpClient: MockHttpClient;
  let client: AdminApiClient;

  beforeEach(() => {
    mockHttpClient = new MockHttpClient();
    client = new AdminApiClient(mockHttpClient);
  });

  describe('Health and Status', () => {
    it('should check health', async () => {
      const mockHealth: HealthStatus = { status: 'healthy' };
      const mockResponse = { data: mockHealth };
      mockHttpClient.setMockResponse('GET', '/health', mockResponse);

      const result = await client.healthCheck();
      expect(result).toEqual(mockHealth);
    });

    it('should get auth status', async () => {
      const mockAuthStatus: AdminAuthStatus = { status: 'authenticated' };
      mockHttpClient.setMockResponse('GET', '/is-authed', mockAuthStatus);

      const result = await client.isAuthed();
      expect(result).toEqual(mockAuthStatus);
    });
  });

  describe('Context Management', () => {
    it('should create context', async () => {
      const mockRequest: CreateContextRequest = {
        name: 'test-context',
        description: 'Test context',
        metadata: 'test-metadata',
      };
      const mockResponse: CreateContextResponse = {
        contextId: 'ctx-123',
        name: 'test-context',
        description: 'Test context',
        metadata: 'test-metadata',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };
      mockHttpClient.setMockResponse('POST', '/contexts', mockResponse);

      const result = await client.createContext(mockRequest);
      expect(result).toEqual(mockResponse);
    });

    it('should list contexts', async () => {
      const mockResponse: ListContextsResponse = [
        {
          contextId: 'ctx-123',
          name: 'test-context',
          description: 'Test context',
          metadata: 'test-metadata',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-01T00:00:00Z',
        },
      ];
      mockHttpClient.setMockResponse('GET', '/contexts', mockResponse);

      const result = await client.getContexts();
      expect(result).toEqual(mockResponse);
    });

    it('should get context', async () => {
      const mockResponse: GetContextResponse = {
        contextId: 'ctx-123',
        name: 'test-context',
        description: 'Test context',
        metadata: 'test-metadata',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
      };
      mockHttpClient.setMockResponse('GET', '/contexts/ctx-123', mockResponse);

      const result = await client.getContext('ctx-123');
      expect(result).toEqual(mockResponse);
    });

    it('should delete context', async () => {
      const mockResponse: DeleteContextResponse = { success: true };
      mockHttpClient.setMockResponse(
        'DELETE',
        '/contexts/ctx-123',
        mockResponse,
      );

      const result = await client.deleteContext('ctx-123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('Blob Management', () => {
    it('should upload blob', async () => {
      const mockRequest: UploadBlobRequest = {
        name: 'test-blob',
        data: 'base64encodeddata',
      };
      const mockResponse: UploadBlobResponse = { blobId: 'blob-123' };
      mockHttpClient.setMockResponse('POST', '/blobs', mockResponse);

      const result = await client.uploadBlob(mockRequest);
      expect(result).toEqual(mockResponse);
    });

    it('should list blobs', async () => {
      const mockResponse: ListBlobsResponse = [
        {
          blobId: 'blob-123',
          name: 'test-blob',
          size: 100,
          createdAt: '2023-01-01T00:00:00Z',
        },
      ];
      mockHttpClient.setMockResponse('GET', '/blobs', mockResponse);

      const result = await client.listBlobs();
      expect(result).toEqual(mockResponse);
    });

    it('should get blob', async () => {
      const mockResponse: GetBlobResponse = {
        blobId: 'blob-123',
        name: 'test-blob',
        size: 100,
        data: 'base64encodeddata',
        createdAt: '2023-01-01T00:00:00Z',
      };
      mockHttpClient.setMockResponse('GET', '/blobs/blob-123', mockResponse);

      const result = await client.getBlob('blob-123');
      expect(result).toEqual(mockResponse);
    });

    it('should delete blob', async () => {
      const mockResponse: DeleteBlobResponse = { success: true };
      mockHttpClient.setMockResponse('DELETE', '/blobs/blob-123', mockResponse);

      const result = await client.deleteBlob('blob-123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('Alias Management', () => {
    it('should create alias', async () => {
      const mockRequest: CreateAliasRequest = {
        name: 'test-alias',
        target: 'test-target',
      };
      const mockResponse: CreateAliasResponse = { aliasId: 'alias-123' };
      mockHttpClient.setMockResponse('POST', '/alias', mockResponse);

      const result = await client.createAlias(mockRequest);
      expect(result).toEqual(mockResponse);
    });

    it('should list aliases', async () => {
      const mockResponse: ListAliasesResponse = [
        {
          aliasId: 'alias-123',
          name: 'test-alias',
          target: 'test-target',
          createdAt: '2023-01-01T00:00:00Z',
        },
      ];
      mockHttpClient.setMockResponse('GET', '/alias', mockResponse);

      const result = await client.listAliases();
      expect(result).toEqual(mockResponse);
    });

    it('should get alias', async () => {
      const mockResponse: GetAliasResponse = {
        aliasId: 'alias-123',
        name: 'test-alias',
        target: 'test-target',
        createdAt: '2023-01-01T00:00:00Z',
      };
      mockHttpClient.setMockResponse('GET', '/alias/alias-123', mockResponse);

      const result = await client.getAlias('alias-123');
      expect(result).toEqual(mockResponse);
    });

    it('should delete alias', async () => {
      const mockResponse: DeleteAliasResponse = { success: true };
      mockHttpClient.setMockResponse(
        'DELETE',
        '/alias/alias-123',
        mockResponse,
      );

      const result = await client.deleteAlias('alias-123');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('Network Management', () => {
    it('should get network peers', async () => {
      const mockResponse: GetNetworkPeersResponse = {
        peers: [{ id: 'peer-1', address: '127.0.0.1' }],
      };
      mockHttpClient.setMockResponse('GET', '/network/peers', mockResponse);

      const result = await client.getNetworkPeers();
      expect(result).toEqual(mockResponse);
    });

    it('should get network stats', async () => {
      const mockResponse: GetNetworkStatsResponse = {
        connections: 1,
        trafficIn: 100,
        trafficOut: 200,
      };
      mockHttpClient.setMockResponse('GET', '/network/stats', mockResponse);

      const result = await client.getNetworkStats();
      expect(result).toEqual(mockResponse);
    });

    it('should get network config', async () => {
      const mockResponse: GetNetworkConfigResponse = {
        listenAddress: '0.0.0.0',
        rpcPort: 3000,
      };
      mockHttpClient.setMockResponse('GET', '/network/config', mockResponse);

      const result = await client.getNetworkConfig();
      expect(result).toEqual(mockResponse);
    });

    it('should update network config', async () => {
      const mockRequest: UpdateNetworkConfigRequest = { rpcPort: 3001 };
      const mockResponse: UpdateNetworkConfigResponse = { success: true };
      mockHttpClient.setMockResponse('PUT', '/network/config', mockResponse);

      const result = await client.updateNetworkConfig(mockRequest);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('System Management', () => {
    it('should get system info', async () => {
      const mockResponse: GetSystemInfoResponse = {
        version: '1.0.0',
        uptime: 12345,
      };
      mockHttpClient.setMockResponse('GET', '/system/info', mockResponse);

      const result = await client.getSystemInfo();
      expect(result).toEqual(mockResponse);
    });

    it('should get system logs', async () => {
      const mockResponse: GetSystemLogsResponse = { logs: ['log1', 'log2'] };
      mockHttpClient.setMockResponse('GET', '/system/logs', mockResponse);

      const result = await client.getSystemLogs();
      expect(result).toEqual(mockResponse);
    });

    it('should get system metrics', async () => {
      const mockResponse: GetSystemMetricsResponse = {
        cpu: 0.5,
        memory: 0.7,
      };
      mockHttpClient.setMockResponse('GET', '/system/metrics', mockResponse);

      const result = await client.getSystemMetrics();
      expect(result).toEqual(mockResponse);
    });

    it('should restart system', async () => {
      const mockResponse: RestartSystemResponse = { success: true };
      mockHttpClient.setMockResponse('POST', '/system/restart', mockResponse);

      const result = await client.restartSystem();
      expect(result).toEqual(mockResponse);
    });

    it('should shutdown system', async () => {
      const mockResponse: ShutdownSystemResponse = { success: true };
      mockHttpClient.setMockResponse('POST', '/system/shutdown', mockResponse);

      const result = await client.shutdownSystem();
      expect(result).toEqual(mockResponse);
    });
  });

  describe('Application Management', () => {
    it('should install application', async () => {
      const mockRequest: InstallApplicationRequest = {
        url: 'http://example.com/app.wasm',
        metadata: 'metadata',
      };
      const mockResponse: InstallApplicationResponse = {
        applicationId: 'app-123',
      };
      mockHttpClient.setMockResponse('POST', '/applications', mockResponse);

      const result = await client.installApplication(mockRequest);
      expect(result).toEqual(mockResponse);
    });

    it('should install dev application', async () => {
      const mockRequest: InstallDevApplicationRequest = {
        path: '/path/to/app.wasm',
        metadata: 'metadata',
      };
      const mockResponse: InstallApplicationResponse = {
        applicationId: 'app-123-dev',
      };
      mockHttpClient.setMockResponse('POST', '/applications/dev', mockResponse);

      const result = await client.installDevApplication(mockRequest);
      expect(result).toEqual(mockResponse);
    });

    it('should uninstall application', async () => {
      const mockResponse: UninstallApplicationResponse = { success: true };
      mockHttpClient.setMockResponse(
        'DELETE',
        '/applications/app-123',
        mockResponse,
      );

      const result = await client.uninstallApplication('app-123');
      expect(result).toEqual(mockResponse);
    });

    it('should list applications', async () => {
      const mockResponse: ListApplicationsResponse = [
        {
          applicationId: 'app-123',
          url: 'http://example.com/app.wasm',
          status: 'installed',
          createdAt: '2023-01-01T00:00:00Z',
        },
      ];
      mockHttpClient.setMockResponse('GET', '/applications', mockResponse);

      const result = await client.listApplications();
      expect(result).toEqual(mockResponse);
    });

    it('should get application', async () => {
      const mockResponse: GetApplicationResponse = {
        applicationId: 'app-123',
        url: 'http://example.com/app.wasm',
        status: 'installed',
        createdAt: '2023-01-01T00:00:00Z',
      };
      mockHttpClient.setMockResponse(
        'GET',
        '/applications/app-123',
        mockResponse,
      );

      const result = await client.getApplication('app-123');
      expect(result).toEqual(mockResponse);
    });
  });
});
