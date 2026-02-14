import { createBrowserHttpClient } from './http-client';
import { createAuthApiClientFromHttpClient } from './auth-api';
import { createAdminApiClientFromHttpClient } from './admin-api';
import type { AuthApiClient } from './auth-api';
import type { AdminApiClient } from './admin-api';
import type { HttpClient } from './http-client';

export interface MeroJsConfig {
  /** Base URL for the Calimero node */
  baseUrl: string;
  /** Initial credentials for authentication */
  credentials?: {
    username: string;
    password: string;
  };
  /** Custom HTTP client timeout in milliseconds */
  timeoutMs?: number;
  /** Request credentials mode for fetch (omit, same-origin, include) */
  requestCredentials?: RequestCredentials;
}

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/**
 * Parse the expiry time from a JWT token's exp claim
 * @param token - The JWT access token
 * @returns The expiry time in milliseconds, or null if parsing fails
 */
export function parseJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    // Decode the payload (second part) using base64url decoding
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64));
    if (typeof payload.exp === 'number') {
      // JWT exp is in seconds, convert to milliseconds
      return payload.exp * 1000;
    }
    return null;
  } catch {
    return null;
  }
}

/** Default token expiry duration (24 hours in milliseconds) */
const DEFAULT_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Main MeroJs SDK class that manages all API clients and authentication
 */
export class MeroJs {
  private config: MeroJsConfig;
  private httpClient: HttpClient;
  private authClient: AuthApiClient;
  private adminClient: AdminApiClient;
  private tokenData: TokenData | null = null;
  private refreshPromise: Promise<TokenData> | null = null;

  constructor(config: MeroJsConfig) {
    this.config = {
      timeoutMs: 10000,
      ...config,
    };

    // Create HTTP client with token management
    // For Tauri, explicitly set credentials to 'omit' to avoid network errors
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    this.httpClient = createBrowserHttpClient({
      baseUrl: this.config.baseUrl,
      getAuthToken: async () => {
        const token = await this.getValidToken();
        return token?.access_token || '';
      },
      timeoutMs: this.config.timeoutMs,
      credentials: this.config.requestCredentials ?? (isTauri ? 'omit' : undefined),
    });

    // Create API clients
    this.authClient = createAuthApiClientFromHttpClient(this.httpClient, {
      baseUrl: this.config.baseUrl,
      getAuthToken: async () => {
        const token = await this.getValidToken();
        return token?.access_token || '';
      },
      timeoutMs: this.config.timeoutMs,
    });

    this.adminClient = createAdminApiClientFromHttpClient(this.httpClient, {
      baseUrl: this.config.baseUrl,
      getAuthToken: async () => {
        const token = await this.getValidToken();
        return token?.access_token || '';
      },
      timeoutMs: this.config.timeoutMs,
    });

    // Token management is in-memory only
  }

  /**
   * Get the Auth API client
   */
  get auth(): AuthApiClient {
    return this.authClient;
  }

  /**
   * Get the Admin API client
   */
  get admin(): AdminApiClient {
    return this.adminClient;
  }

  /**
   * Authenticate with the provided credentials
   * This will create the root key on first use
   */
  async authenticate(credentials?: {
    username: string;
    password: string;
  }): Promise<TokenData> {
    const creds = credentials || this.config.credentials;
    if (!creds) {
      throw new Error('No credentials provided for authentication');
    }

    try {
      const requestBody = {
        auth_method: 'user_password',
        public_key: creds.username,
        client_name: 'mero-js-sdk',
        permissions: ['admin'],
        timestamp: Math.floor(Date.now() / 1000),
        provider_data: {
          username: creds.username,
          password: creds.password,
        },
      };

      const response = await this.authClient.generateTokens(requestBody);

      // Parse actual expiry from JWT, fall back to default 24 hours if not available
      const jwtExpiry = parseJwtExpiry(response.data.access_token);
      this.tokenData = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_at: jwtExpiry ?? Date.now() + DEFAULT_TOKEN_EXPIRY_MS,
      };

      return this.tokenData;
    } catch (error) {
      throw new Error(
        `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get a valid token, refreshing if necessary
   */
  private async getValidToken(): Promise<TokenData | null> {
    if (!this.tokenData) {
      return null;
    }

    // Check if token is expired (with 5 minute buffer)
    const bufferTime = 5 * 60 * 1000; // 5 minutes
    if (Date.now() >= this.tokenData.expires_at - bufferTime) {
      return await this.refreshToken();
    }

    return this.tokenData;
  }

  /**
   * Refresh the access token using the refresh token
   */
  private async refreshToken(): Promise<TokenData> {
    if (!this.tokenData?.refresh_token) {
      throw new Error('No refresh token available');
    }

    // Prevent multiple simultaneous refresh attempts
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performTokenRefresh();

    try {
      const newToken = await this.refreshPromise;
      return newToken;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Perform the actual token refresh
   */
  private async performTokenRefresh(): Promise<TokenData> {
    try {
      const response = await this.authClient.refreshToken({
        access_token: this.tokenData!.access_token,
        refresh_token: this.tokenData!.refresh_token,
      });

      // Parse actual expiry from JWT, fall back to default 24 hours if not available
      const jwtExpiry = parseJwtExpiry(response.data.access_token);
      this.tokenData = {
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token,
        expires_at: jwtExpiry ?? Date.now() + DEFAULT_TOKEN_EXPIRY_MS,
      };

      return this.tokenData;
    } catch (error) {
      // If refresh fails, clear the token and require re-authentication
      this.clearToken();
      throw new Error(
        `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Clear the current token
   */
  public clearToken(): void {
    this.tokenData = null;
  }

  /**
   * Check if the SDK is authenticated
   */
  public isAuthenticated(): boolean {
    return this.tokenData !== null;
  }

  /**
   * Get the current token data (for debugging)
   */
  public getTokenData(): TokenData | null {
    return this.tokenData;
  }
}

/**
 * Create a new MeroJs SDK instance
 */
export function createMeroJs(config: MeroJsConfig): MeroJs {
  return new MeroJs(config);
}
