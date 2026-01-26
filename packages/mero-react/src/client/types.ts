// Types for mero-react client
export interface ApiResponse<T> {
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
}

// Provider type - adapts to mero-js AuthProvider
export interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  // Legacy fields for backwards compatibility
  type?: string;
  description?: string;
  configured?: boolean;
  config?: Record<string, unknown>;
}

export interface ProvidersResponse {
  providers: Provider[];
  count: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

export interface ClientConfig {
  baseUrl: string;
  authBaseUrl?: string;
  requestCredentials?: RequestCredentials;
  timeoutMs?: number;
}

// Re-export mero-js types for convenience
export type { TokenData, TokenStorage, MeroJsConfig } from '@calimero-network/mero-js';