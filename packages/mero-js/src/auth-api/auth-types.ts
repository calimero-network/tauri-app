// Auth API Types - Generated from OpenAPI 3.0.3 specification

// Re-export shared types
export { ApiResponse } from '../http-client';

// Health and Status Types
export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  storage: boolean;
  uptimeSeconds: number;
}

export interface IdentityResponse {
  service: string;
  version: string;
  authenticationMode: string;
  providers: string[];
}

export interface ProvidersResponse {
  providers: Array<{
    name: string;
    type: string;
    description: string;
    configured: boolean;
    config: Record<string, any>;
  }>;
  count: number;
}

// Authentication Types
export interface TokenRequest {
  auth_method: string;
  public_key: string;
  client_name: string;
  permissions?: string[];
  timestamp: number;
  provider_data: Record<string, any>;
}

export interface TokenResponse {
  data: {
    access_token: string;
    refresh_token: string;
    error?: string | null;
  };
  error?: string | null;
}

export interface RefreshTokenRequest {
  access_token: string;
  refresh_token: string;
}

export interface ChallengeResponse {
  challenge: string;
  expiresAt: string;
}

// Mock Token (testing)
export interface MockTokenRequest {
  clientName: string;
  permissions?: string[];
  expiresIn?: number;
}

// Token Management Types
export interface RevokeTokenRequest {
  token: string;
  reason?: string;
}

export interface RevokeTokenResponse {
  success: boolean;
  message: string;
}

// Key Management Types
export interface CreateKeyRequest {
  name: string;
  permissions: string[];
  expiresAt?: string;
}

export interface CreateKeyResponse {
  keyId: string;
  name: string;
  permissions: string[];
  createdAt: string;
  expiresAt?: string;
}

export interface DeleteKeyResponse {
  success: boolean;
  message: string;
}

export interface RootKeysResponse {
  keys: Array<{
    key_id: string;
    name: string;
    permissions: string[];
    created_at: string;
    expires_at?: string;
  }>;
  count: number;
}

// Client Management Types
export interface ClientKeysResponse {
  clients: Array<{
    client_id: string;
    key_id: string;
    name: string;
    permissions: string[];
    created_at: string;
    last_used?: string;
  }>;
  count: number;
}

export interface GenerateClientKeyRequest {
  keyId: string;
  clientName: string;
  permissions: string[];
  expiresAt?: string;
}

export interface DeleteClientResponse {
  success: boolean;
  message: string;
}

// Permission Management Types
export interface PermissionResponse {
  data: {
    permissions: string[];
  };
  error?: string | null;
}

// Auth Status Types
export interface AuthStatus {
  status: string;
  authenticated: boolean;
  user?: {
    id: string;
    name: string;
    permissions: string[];
  };
}

// Client Configuration
export interface AuthApiClientConfig {
  baseUrl: string;
  getAuthToken?: () => Promise<string | undefined>;
  timeoutMs?: number;
}
