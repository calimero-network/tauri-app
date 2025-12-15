// Types matching calimero-client API
export interface ApiResponse<T> {
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
}

export interface Provider {
  name: string;
  type: string;
  description: string;
  configured: boolean;
  config?: Record<string, any>;
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
  authBaseUrl?: string; // Optional separate auth URL
  requestCredentials?: RequestCredentials;
  timeoutMs?: number;
}

