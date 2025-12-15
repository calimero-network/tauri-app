import { HttpClient } from '../http-client';
import {
  // Common types
  ApiResponse,
  // Health and Status
  HealthResponse,
  IdentityResponse,
  ProvidersResponse,
  // Authentication
  TokenRequest,
  TokenResponse,
  RefreshTokenRequest,
  ChallengeResponse,
  // Mock Token (testing)
  MockTokenRequest,
  // Token Management
  RevokeTokenRequest,
  RevokeTokenResponse,
  // Key Management
  CreateKeyRequest,
  CreateKeyResponse,
  DeleteKeyResponse,
  RootKeysResponse,
  // Client Management
  ClientKeysResponse,
  GenerateClientKeyRequest,
  DeleteClientResponse,
  // Permissions
  PermissionResponse,
  // Auth Status
  AuthStatus,
} from './auth-types';

export class AuthApiClient {
  constructor(private httpClient: HttpClient) {}

  // Health and Status Endpoints
  async getHealth(): Promise<HealthResponse> {
    const response =
      await this.httpClient.get<ApiResponse<HealthResponse>>('/auth/health');
    if (!response.data) {
      throw new Error('Health response data is null');
    }
    return response.data;
  }

  async getIdentity(): Promise<IdentityResponse> {
    const response =
      await this.httpClient.get<ApiResponse<IdentityResponse>>(
        '/admin/identity',
      );
    if (!response.data) {
      throw new Error('Identity response data is null');
    }
    return response.data;
  }

  async getProviders(): Promise<ProvidersResponse> {
    const response =
      await this.httpClient.get<ApiResponse<ProvidersResponse>>(
        '/auth/providers',
      );
    if (!response.data) {
      throw new Error('Providers response data is null');
    }
    return response.data;
  }

  // Authentication Endpoints
  async getLoginPage(): Promise<string> {
    return this.httpClient.get<string>('/auth/login', { parse: 'text' });
  }

  async generateTokens(request: TokenRequest): Promise<TokenResponse> {
    return this.httpClient.post<TokenResponse>('/auth/token', request);
  }

  async refreshToken(request: RefreshTokenRequest): Promise<TokenResponse> {
    return this.httpClient.post<TokenResponse>('/auth/refresh', request);
  }

  async generateMockTokens(request: MockTokenRequest): Promise<TokenResponse> {
    return this.httpClient.post<TokenResponse>('/auth/mock-token', request);
  }

  async getChallenge(): Promise<ChallengeResponse> {
    return this.httpClient.get<ChallengeResponse>('/auth/challenge');
  }

  async validateToken(token: string): Promise<{
    valid: boolean;
    headers: Record<string, string>;
    status: number;
  }> {
    try {
      const response = await this.validateTokenGet(token);
      return {
        valid: response.status === 200,
        headers: response.headers,
        status: response.status,
      };
    } catch (error) {
      return {
        valid: false,
        headers: {},
        status: 401,
      };
    }
  }

  async validateTokenGet(
    token: string,
  ): Promise<{ status: number; headers: Record<string, string> }> {
    const response = await this.httpClient.head('/auth/validate', {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      status: response.status,
      headers: response.headers,
    };
  }

  async isAuthed(): Promise<AuthStatus> {
    return this.httpClient.get<AuthStatus>('/auth/is-authed');
  }

  // Token Management Endpoints
  async revokeTokens(
    request: RevokeTokenRequest,
  ): Promise<RevokeTokenResponse> {
    return this.httpClient.post<RevokeTokenResponse>('/admin/revoke', request);
  }

  // Key Management Endpoints
  async listRootKeys(): Promise<RootKeysResponse> {
    const response =
      await this.httpClient.get<ApiResponse<RootKeysResponse>>('/admin/keys');
    if (!response.data) {
      throw new Error('Root keys response data is null');
    }
    return response.data;
  }

  async createRootKey(request: CreateKeyRequest): Promise<CreateKeyResponse> {
    return this.httpClient.post<CreateKeyResponse>('/admin/keys', request);
  }

  async deleteRootKey(keyId: string): Promise<DeleteKeyResponse> {
    return this.httpClient.delete<DeleteKeyResponse>(`/admin/keys/${keyId}`);
  }

  // Client Management Endpoints
  async listClientKeys(): Promise<ClientKeysResponse> {
    const response = await this.httpClient.get<ApiResponse<ClientKeysResponse>>(
      '/admin/keys/clients',
    );
    if (!response.data) {
      throw new Error('Client keys response data is null');
    }
    return response.data;
  }

  async generateClientKey(
    request: GenerateClientKeyRequest,
  ): Promise<TokenResponse> {
    return this.httpClient.post<TokenResponse>('/admin/client-key', request);
  }

  async deleteClientKey(
    keyId: string,
    clientId: string,
  ): Promise<DeleteClientResponse> {
    return this.httpClient.delete<DeleteClientResponse>(
      `/admin/keys/${keyId}/clients/${clientId}`,
    );
  }

  // Permission Management Endpoints
  async getKeyPermissions(keyId: string): Promise<PermissionResponse> {
    return this.httpClient.get<PermissionResponse>(
      `/admin/keys/${keyId}/permissions`,
    );
  }

  async updateKeyPermissions(
    keyId: string,
    permissions: string[],
  ): Promise<PermissionResponse> {
    return this.httpClient.put<PermissionResponse>(
      `/admin/keys/${keyId}/permissions`,
      { permissions },
    );
  }
}
