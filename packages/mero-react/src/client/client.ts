import { MeroJs, type TokenStorage, type TokenData } from '@calimero-network/mero-js';
import type { ApiResponse, ClientConfig, Provider, TokenResponse } from './types';

/**
 * LocalStorage-based TokenStorage implementation for browser/Tauri
 */
class LocalStorageTokenStorage implements TokenStorage {
  private readonly key = 'mero-token';

  async get(): Promise<TokenData | null> {
    try {
      const data = localStorage.getItem(this.key);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  async set(token: TokenData): Promise<void> {
    localStorage.setItem(this.key, JSON.stringify(token));
  }

  async clear(): Promise<void> {
    localStorage.removeItem(this.key);
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
      // mero-js returns AuthProvider[] directly
      const providers = await this.meroJs.auth.getProviders();
      const providersList = Array.isArray(providers) ? providers : [];
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
          count: providersList.length,
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
      // mero-js refreshToken only needs refresh_token
      const response = await this.meroJs.auth.refreshToken({
        refresh_token: payload.refresh_token,
      });

      if (response.access_token && response.refresh_token) {
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
  constructor(private meroJs: MeroJs) {}

  async healthCheck(): Promise<ApiResponse<{ status: string }>> {
    try {
      const health = await this.meroJs.admin.public.health();
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
    // Create MeroJs instance with token storage
    this.meroJs = new MeroJs({
      baseUrl: config.baseUrl,
      authBaseUrl: config.authBaseUrl,
      timeoutMs: config.timeoutMs,
      requestCredentials: config.requestCredentials,
      tokenStorage: new LocalStorageTokenStorage(),
    });

    this.auth = new AuthApi(this.meroJs, config);
    this.node = new NodeApi(this.meroJs);
  }

  /**
   * Initialize the client (load tokens from storage)
   */
  async init(): Promise<void> {
    await this.meroJs.init();
  }
}

export function createClient(config: ClientConfig): Client {
  const client = new Client(config);
  
  // Initialize async (load tokens)
  client.init().catch(console.error);
  
  // Update global singleton
  import('./singleton').then(({ setClientInstance }) => {
    setClientInstance(client);
  });
  
  return client;
}

export type { ClientConfig };
