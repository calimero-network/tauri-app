import { MeroJs, type TokenStorage, type TokenData } from '@calimero-network/mero-js';
import type { ApiResponse, ClientConfig, Provider, TokenResponse } from './types';
import { setClientInstance } from './singleton';

/**
 * LocalStorage-based TokenStorage implementation for browser/Tauri
 * 
 * IMPORTANT: Uses the same keys as the exported token-storage utilities
 * to maintain consistency across login flows and API calls.
 */
class LocalStorageTokenStorage implements TokenStorage {
  // Match the keys from token-storage.ts
  private readonly ACCESS_TOKEN_KEY = 'calimero_access_token';
  private readonly REFRESH_TOKEN_KEY = 'calimero_refresh_token';
  private readonly EXPIRES_AT_KEY = 'calimero_token_expires_at';

  async get(): Promise<TokenData | null> {
    try {
      const accessToken = localStorage.getItem(this.ACCESS_TOKEN_KEY);
      const refreshToken = localStorage.getItem(this.REFRESH_TOKEN_KEY);
      const expiresAt = localStorage.getItem(this.EXPIRES_AT_KEY);
      
      console.log('[TokenStorage.get] accessToken:', accessToken ? 'EXISTS' : 'NULL');
      console.log('[TokenStorage.get] refreshToken:', refreshToken ? 'EXISTS' : 'NULL');
      console.log('[TokenStorage.get] expiresAt:', expiresAt);
      
      if (!accessToken || !refreshToken) {
        console.log('[TokenStorage.get] Missing tokens, returning null');
        return null;
      }
      
      const tokenData = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt ? parseInt(expiresAt, 10) : Date.now() + 3600000,
      };
      console.log('[TokenStorage.get] Returning tokenData with expires_at:', tokenData.expires_at);
      return tokenData;
    } catch (error) {
      console.error('[TokenStorage.get] Error:', error);
      return null;
    }
  }

  async set(token: TokenData): Promise<void> {
    localStorage.setItem(this.ACCESS_TOKEN_KEY, token.access_token);
    localStorage.setItem(this.REFRESH_TOKEN_KEY, token.refresh_token);
    if (token.expires_at) {
      localStorage.setItem(this.EXPIRES_AT_KEY, token.expires_at.toString());
    }
  }

  async clear(): Promise<void> {
    localStorage.removeItem(this.ACCESS_TOKEN_KEY);
    localStorage.removeItem(this.REFRESH_TOKEN_KEY);
    localStorage.removeItem(this.EXPIRES_AT_KEY);
  }
}

// Auth API wrapper - maintains compatibility with existing code
class AuthApi {
  constructor(
    private meroJs: MeroJs,
    private _config: ClientConfig,
  ) {}

  async getHealth(): Promise<ApiResponse<{ status: string }>> {
    try {
      const response = await this.meroJs.auth.getHealth();
      return {
        data: {
          status: response.status,
        },
      };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to get auth health',
        },
      };
    }
  }

  async getProviders(): Promise<ApiResponse<{ providers: Provider[]; count: number }>> {
    try {
      // mero-js returns { providers: AuthProvider[], count?: number }
      const response = await this.meroJs.auth.getProviders();
      const providersList = response.providers || [];
      return {
        data: {
          providers: providersList.map((p) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled,
            // Map to legacy fields for backwards compatibility
            type: p.name,
            description: '',
            configured: p.enabled,
          })),
          count: response.count ?? providersList.length,
        },
      };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to get providers',
        },
      };
    }
  }

  async requestToken(payload: {
    auth_method: string;
    public_key: string;
    client_name: string;
    timestamp: number;
    permissions: string[];
    provider_data?: Record<string, unknown>;
  }): Promise<ApiResponse<TokenResponse>> {
    try {
      // mero-js auth.getToken uses snake_case matching the server API
      const response = await this.meroJs.auth.getToken({
        auth_method: payload.auth_method as 'user_password' | 'near_wallet' | 'eth_wallet' | 'starknet_wallet' | 'icp_wallet',
        public_key: payload.public_key,
        client_name: payload.client_name,
        timestamp: payload.timestamp,
        provider_data: payload.provider_data || {},
        permissions: payload.permissions,
      });

      if (response.access_token && response.refresh_token) {
        // Extract expiry from JWT (more reliable than expires_in)
        let expiresAt: number;
        try {
          const payload = JSON.parse(atob(response.access_token.split('.')[1]));
          expiresAt = payload.exp * 1000; // JWT exp is in seconds
          console.log('[AuthApi.requestToken] JWT exp:', payload.exp, '-> expires_at:', expiresAt);
        } catch (e) {
          expiresAt = Date.now() + (response.expires_in || 3600) * 1000;
          console.warn('[AuthApi.requestToken] Failed to parse JWT, using fallback:', expiresAt);
        }
        
        // Store the token in MeroJs so subsequent calls are authenticated
        await this.meroJs.setToken({
          access_token: response.access_token,
          refresh_token: response.refresh_token,
          expires_at: expiresAt,
        });
        
        return {
          data: {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
          },
        };
      }
      return {
        error: {
          message: 'Failed to generate tokens',
        },
      };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to request token',
        },
      };
    }
  }

  async refreshToken(payload: {
    access_token: string;
    refresh_token: string;
  }): Promise<ApiResponse<TokenResponse>> {
    try {
      // Server requires BOTH access_token and refresh_token (snake_case)
      const response = await this.meroJs.auth.refreshToken({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });

      if (response.access_token && response.refresh_token) {
        // Extract expiry from JWT (more reliable than expires_in)
        let expiresAt: number;
        try {
          const payload = JSON.parse(atob(response.access_token.split('.')[1]));
          expiresAt = payload.exp * 1000; // JWT exp is in seconds
          console.log('[AuthApi.refreshToken] JWT exp:', payload.exp, '-> expires_at:', expiresAt);
        } catch (e) {
          expiresAt = Date.now() + (response.expires_in || 3600) * 1000;
          console.warn('[AuthApi.refreshToken] Failed to parse JWT, using fallback:', expiresAt);
        }
        
        // Store the new token in MeroJs
        await this.meroJs.setToken({
          access_token: response.access_token,
          refresh_token: response.refresh_token,
          expires_at: expiresAt,
        });
        
        return {
          data: {
            access_token: response.access_token,
            refresh_token: response.refresh_token,
          },
        };
      }
      return {
        error: {
          message: 'Failed to refresh token',
        },
      };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to refresh token',
        },
      };
    }
  }

  async getChallenge(): Promise<ApiResponse<{ challenge: string; nonce: string }>> {
    try {
      const response = await this.meroJs.auth.getChallenge();
      return {
        data: {
          challenge: response.challenge,
          nonce: response.nonce,
        },
      };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to get challenge',
        },
      };
    }
  }

  async generateClientKey(payload: {
    context_id: string;
    context_identity: string;
    permissions: string[];
  }): Promise<ApiResponse<{ keyId: string; permissions: string[] }>> {
    try {
      // mero-js auth.generateClientKey returns ClientKey, not tokens
      const response = await this.meroJs.auth.generateClientKey({
        contextId: payload.context_id,
        contextIdentity: payload.context_identity,
        permissions: payload.permissions,
      });

      return {
        data: {
          keyId: response.keyId,
          permissions: response.permissions,
        },
      };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to generate client key',
        },
      };
    }
  }
}

// Node API wrapper - maintains compatibility with existing code
class NodeApi {
  constructor(private meroJs: MeroJs) {
    console.log('[NodeApi] Created with meroJs:', !!meroJs);
    console.log('[NodeApi] meroJs.admin:', !!(meroJs as any)?.admin);
    console.log('[NodeApi] meroJs.admin?.public:', !!(meroJs as any)?.admin?.public);
  }

  async healthCheck(): Promise<ApiResponse<{ status: string }>> {
    try {
      console.log('[NodeApi.healthCheck] Checking health...');
      console.log('[NodeApi.healthCheck] meroJs:', !!this.meroJs);
      
      if (!this.meroJs) {
        return { error: { message: 'MeroJs not initialized' } };
      }
      
      const admin = this.meroJs.admin;
      console.log('[NodeApi.healthCheck] admin:', !!admin);
      console.log('[NodeApi.healthCheck] admin type:', typeof admin);
      console.log('[NodeApi.healthCheck] admin constructor:', admin?.constructor?.name);
      
      if (!admin) {
        return { error: { message: 'MeroJs.admin not available' } };
      }
      
      // Try to access public getter with explicit error handling
      let publicApi;
      try {
        publicApi = admin.public;
        console.log('[NodeApi.healthCheck] public:', !!publicApi);
        console.log('[NodeApi.healthCheck] public type:', typeof publicApi);
      } catch (e) {
        console.error('[NodeApi.healthCheck] Error accessing admin.public:', e);
        return { error: { message: `Error accessing admin.public: ${e}` } };
      }
      
      if (!publicApi) {
        console.error('[NodeApi.healthCheck] admin.public is falsy:', publicApi);
        return { error: { message: 'MeroJs.admin.public not available' } };
      }
      
      const health = await publicApi.health();
      return { data: { status: health.status } };
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string };
      if (err?.status === 401 || (error instanceof Error && error.message.includes('401'))) {
        return {
          error: {
            message: 'Unauthorized',
            code: '401',
          },
        };
      }
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to check health',
        },
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getContexts(): Promise<ApiResponse<any[]>> {
    try {
      const response = await this.meroJs.admin.contexts.listContexts();
      return { data: response.contexts || [] };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err?.status === 401) {
        return {
          error: {
            message: 'Unauthorized',
            code: '401',
          },
        };
      }
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to get contexts',
        },
      };
    }
  }

  async createContext(request: {
    protocol: string;
    applicationId: string;
    contextSeed?: string;
    initializationParams: number[];
  }): Promise<ApiResponse<{ contextId: string; memberPublicKey: string }>> {
    try {
      const response = await this.meroJs.admin.contexts.createContext({
        protocol: request.protocol,
        applicationId: request.applicationId,
        contextSeed: request.contextSeed,
        initializationParams: request.initializationParams,
      });
      return {
        data: {
          contextId: response.contextId,
          memberPublicKey: response.memberPublicKey,
        },
      };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err?.status === 401) {
        return {
          error: {
            message: 'Unauthorized',
            code: '401',
          },
        };
      }
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to create context',
        },
      };
    }
  }

  async deleteContext(contextId: string): Promise<ApiResponse<{ contextId: string }>> {
    try {
      await this.meroJs.admin.contexts.deleteContext(contextId);
      return { data: { contextId } };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err?.status === 401) {
        return {
          error: {
            message: 'Unauthorized',
            code: '401',
          },
        };
      }
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to delete context',
        },
      };
    }
  }

  async fetchContextIdentities(contextId: string): Promise<ApiResponse<string[]>> {
    try {
      const response = await this.meroJs.admin.contexts.getContextIdentitiesOwned(contextId);
      return { data: (response.identities || []) as string[] };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to fetch context identities',
        },
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getInstalledApplicationDetails(applicationId: string): Promise<ApiResponse<any>> {
    try {
      const response = await this.meroJs.admin.applications.getApplication(applicationId);
      return { data: response };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to get application details',
        },
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async listApplications(): Promise<ApiResponse<any[]>> {
    try {
      if (!this.meroJs?.admin?.applications) {
        console.error('[NodeApi.listApplications] MeroJs not fully initialized');
        return { error: { message: 'Client not initialized. Please wait and try again.' } };
      }
      const response = await this.meroJs.admin.applications.listApplications();
      return { data: response.apps || [] };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err?.status === 401) {
        return {
          error: {
            message: 'Unauthorized',
            code: '401',
          },
        };
      }
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to list applications',
        },
      };
    }
  }

  async installApplication(request: {
    url: string;
    hash?: string;
    metadata: number[];
  }): Promise<ApiResponse<{ applicationId: string }>> {
    try {
      const response = await this.meroJs.admin.applications.installApplication({
        url: request.url,
        hash: request.hash,
        metadata: request.metadata,
      });
      return { data: { applicationId: response.applicationId } };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err?.status === 401) {
        return {
          error: {
            message: 'Unauthorized',
            code: '401',
          },
        };
      }
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to install application',
        },
      };
    }
  }

  async uninstallApplication(applicationId: string): Promise<ApiResponse<{ applicationId: string }>> {
    try {
      await this.meroJs.admin.applications.uninstallApplication(applicationId);
      return { data: { applicationId } };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err?.status === 401) {
        return {
          error: {
            message: 'Unauthorized',
            code: '401',
          },
        };
      }
      return {
        error: {
          message: error instanceof Error ? error.message : 'Failed to uninstall application',
        },
      };
    }
  }
}

/**
 * Main client class - wraps MeroJs with backwards-compatible API
 */
export class Client {
  public auth: AuthApi;
  public node: NodeApi;
  public meroJs: MeroJs;

  constructor(config: ClientConfig) {
    console.log('[Client] Constructor called with config:', config);
    
    // Create token storage
    const tokenStorage = new LocalStorageTokenStorage();
    console.log('[Client] Created LocalStorageTokenStorage');
    
    // Create MeroJs instance with token storage
    this.meroJs = new MeroJs({
      baseUrl: config.baseUrl,
      authBaseUrl: config.authBaseUrl,
      timeoutMs: config.timeoutMs,
      requestCredentials: config.requestCredentials,
      tokenStorage: tokenStorage,
    });
    console.log('[Client] Created MeroJs instance');

    this.auth = new AuthApi(this.meroJs, config);
    this.node = new NodeApi(this.meroJs);
    console.log('[Client] Constructor complete');
  }

  /**
   * Initialize the client (load tokens from storage)
   */
  async init(): Promise<void> {
    console.log('[Client.init] START - calling meroJs.init()');
    await this.meroJs.init();
    console.log('[Client.init] END - meroJs.init() completed');
  }
}

/**
 * Create a new client instance synchronously.
 * Note: Tokens are loaded async - use createClientAsync for guaranteed token loading.
 */
export function createClient(config: ClientConfig): Client {
  console.log('[createClient] Creating client with config:', config);
  const client = new Client(config);
  
  // Update global singleton immediately
  setClientInstance(client);
  
  // Initialize async (load tokens from storage)
  // This runs in background - use createClientAsync if you need guaranteed token loading
  client.init().then(() => {
    console.log('[createClient] Token initialization complete');
  }).catch(console.error);
  
  return client;
}

/**
 * Create a new client instance with guaranteed token initialization.
 * Use this when you need tokens to be loaded before making API calls.
 */
export async function createClientAsync(config: ClientConfig): Promise<Client> {
  console.log('[createClientAsync] Creating client with config:', config);
  const client = new Client(config);
  
  // Update global singleton
  setClientInstance(client);
  
  // Wait for token initialization to complete
  console.log('[createClientAsync] Calling init() to load tokens...');
  await client.init();
  
  // Check if tokens were loaded
  const isAuth = client.meroJs.isAuthenticated();
  console.log('[createClientAsync] Token initialization complete, isAuthenticated:', isAuth);
  
  return client;
}

export type { ClientConfig };
