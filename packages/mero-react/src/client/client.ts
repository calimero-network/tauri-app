import { MeroJs, type MeroJsConfig } from '@calimero-network/mero-js';
import { createBrowserHttpClient } from '@calimero-network/mero-js';
import { createAdminApiClientFromHttpClient } from '@calimero-network/mero-js';
import { createAuthApiClientFromHttpClient } from '@calimero-network/mero-js';
import type { ApiResponse, ClientConfig, Provider, TokenResponse } from './types';
import type {
  TokenRequest,
  RefreshTokenRequest,
} from '@calimero-network/mero-js';

// Auth API wrapper matching calimero-client pattern
class AuthApi {
  constructor(
    private authMeroJs: MeroJs,
    private nodeMeroJs: MeroJs,
    private config: ClientConfig,
  ) {}

  async getHealth(): Promise<ApiResponse<{ status: string; storage?: boolean; uptimeSeconds?: number }>> {
    try {
      const response = await this.authMeroJs.auth.getHealth();
      return {
        data: {
          status: response.status,
          storage: response.storage,
          uptimeSeconds: response.uptimeSeconds,
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
      const response = await this.authMeroJs.auth.getProviders();
      return {
        data: {
          providers: response.providers.map((p) => ({
            name: p.name,
            type: p.type,
            description: p.description,
            configured: p.configured,
            config: p.config,
          })),
          count: response.count,
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

  async requestToken(payload: TokenRequest): Promise<ApiResponse<TokenResponse>> {
    try {
      const response = await this.authMeroJs.auth.generateTokens(payload);
      if (response.data?.access_token && response.data?.refresh_token) {
        return {
          data: {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
          },
        };
      }
      return {
        error: {
          message: response.error || 'Failed to generate tokens',
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

  async refreshToken(payload: RefreshTokenRequest): Promise<ApiResponse<TokenResponse>> {
    try {
      const response = await this.authMeroJs.auth.refreshToken(payload);
      if (response.data?.access_token && response.data?.refresh_token) {
        return {
          data: {
            access_token: response.data.access_token,
            refresh_token: response.data.refresh_token,
          },
        };
      }
      return {
        error: {
          message: response.error || 'Failed to refresh token',
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

  async getChallenge(): Promise<ApiResponse<{ challenge: string; expiresAt: string }>> {
    try {
      const response = await this.authMeroJs.auth.getChallenge();
      return {
        data: {
          challenge: response.challenge,
          expiresAt: response.expiresAt,
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
    target_node_url?: string;
  }): Promise<ApiResponse<TokenResponse>> {
    try {
      // The actual API endpoint /admin/client-key accepts this format directly
      // We need to call it using the HTTP client with the auth token
      const accessToken = this.getAccessToken();
      if (!accessToken) {
        return {
          error: {
            message: 'No access token available. Please authenticate first.',
          },
        };
      }

      // Use the auth base URL for the client-key endpoint
      const authBaseUrl = this.config.authBaseUrl || this.config.baseUrl;
      const url = `${authBaseUrl}/admin/client-key`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          context_id: payload.context_id,
          context_identity: payload.context_identity,
          permissions: payload.permissions,
          target_node_url: payload.target_node_url,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          error: {
            message: errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`,
          },
        };
      }

      const data = await response.json();
      if (data.data?.access_token && data.data?.refresh_token) {
        return {
          data: {
            access_token: data.data.access_token,
            refresh_token: data.data.refresh_token,
          },
        };
      }

      return {
        error: {
          message: data.error?.message || 'Failed to generate client key',
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

  private getAccessToken(): string | null {
    // Import token storage functions
    try {
      return localStorage.getItem('calimero_access_token');
    } catch {
      return null;
    }
  }
}

// Node API wrapper matching calimero-client pattern
class NodeApi {
  constructor(
    private meroJs: MeroJs,
    private adminBaseUrl: string,
  ) {}

  async healthCheck(): Promise<ApiResponse<{ status: string }>> {
    try {
      const health = await this.meroJs.admin.healthCheck();
      return { data: { status: health.status } };
    } catch (error: any) {
      // Check if it's a 401 error (HTTPError with status 401)
      if (error?.status === 401 || (error instanceof Error && error.message.includes('401'))) {
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

  async getContexts(): Promise<ApiResponse<any[]>> {
    try {
      const contextsResponse = await this.meroJs.admin.getContexts();
      // mero-js returns ListContextsResponse which has a contexts array
      const contextsArray = (contextsResponse as any).contexts || [];
      return { data: contextsArray };
    } catch (error: any) {
      // Check if it's a 401 error (HTTPError with status 401)
      if (error?.status === 401 || (error instanceof Error && error.message.includes('401'))) {
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

  async fetchContextIdentities(contextId: string): Promise<ApiResponse<any[]>> {
    try {
      // This would need to be implemented in mero-js admin API
      // For now, return empty array
      return { data: [] };
    } catch (error) {
      return {
        error: {
          message:
            error instanceof Error ? error.message : 'Failed to fetch context identities',
        },
      };
    }
  }

  async getInstalledApplicationDetails(
    applicationId: string,
  ): Promise<ApiResponse<any>> {
    try {
      const appsResponse = await this.meroJs.admin.listApplications();
      // mero-js returns ListApplicationsResponse which has an apps array
      const apps = (appsResponse as any).apps || [];
      const app = apps.find((a: any) => a.id === applicationId);
      if (app) {
        return { data: app };
      }
      return {
        error: {
          message: 'Application not found',
        },
      };
    } catch (error) {
      return {
        error: {
          message:
            error instanceof Error
              ? error.message
              : 'Failed to get application details',
        },
      };
    }
  }

  async listApplications(): Promise<ApiResponse<any[]>> {
    try {
      const appsResponse = await this.meroJs.admin.listApplications();
      console.log("🔍 meroJs.admin.listApplications() raw response:", JSON.stringify(appsResponse, null, 2));
      console.log("🔍 appsResponse type:", typeof appsResponse);
      console.log("🔍 appsResponse is object:", typeof appsResponse === 'object');
      
      // Server returns: { data: { apps: [...] } }
      // mero-js HTTP client returns the raw JSON: { data: { apps: [...] } }
      // So appsResponse should be: { data: { apps: [...] } }
      let apps: any[] = [];
      
      if (appsResponse && typeof appsResponse === 'object') {
        const response = appsResponse as any;
        
        // Try all possible extraction paths
        if (response.data?.apps && Array.isArray(response.data.apps)) {
          // Structure: { data: { apps: [...] } }
          apps = response.data.apps;
        } else if (response.apps && Array.isArray(response.apps)) {
          // Structure: { apps: [...] }
          apps = response.apps;
        } else if (Array.isArray(response.data)) {
          // Structure: { data: [...] }
          apps = response.data;
        } else if (Array.isArray(response)) {
          // Structure: [...] (direct array)
          apps = response;
        }
      }
      
      console.log("🔍 Final extracted apps:", apps);
      console.log("🔍 Final apps count:", apps.length);
      return { data: apps };
    } catch (error: any) {
      console.error("🔍 Error in listApplications:", error);
      if (error?.status === 401) {
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
    metadata: number[]; // Array of bytes (Vec<u8> in Rust)
  }): Promise<ApiResponse<{ applicationId: string }>> {
    try {
      const response = await this.meroJs.admin.installApplication(request);
      return { data: response };
    } catch (error: any) {
      if (error?.status === 401) {
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
      const response = await this.meroJs.admin.uninstallApplication(applicationId);
      return { data: response };
    } catch (error: any) {
      if (error?.status === 401) {
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

// Main client class matching calimero-client pattern
export class Client {
  public auth: AuthApi;
  public node: NodeApi;

  constructor(config: ClientConfig) {
    // Extract node base URL (without /admin-api suffix)
    // If baseUrl ends with /admin-api, remove it to get the node base URL
    const nodeBaseUrl = config.baseUrl.endsWith('/admin-api')
      ? config.baseUrl.slice(0, -10) // Remove '/admin-api'
      : config.baseUrl;

    // Helper to get token from localStorage
    const getTokenFromStorage = async (): Promise<string | undefined> => {
      try {
        // Dynamic import to avoid circular dependency
        const { getAccessToken } = await import('./token-storage');
        return getAccessToken() || undefined;
      } catch {
        return undefined;
      }
    };

    // Create HTTP client that reads token from localStorage
    const createHttpClientWithToken = (baseUrl: string) => {
      return createBrowserHttpClient({
        baseUrl,
        getAuthToken: getTokenFromStorage,
        timeoutMs: config.timeoutMs,
        credentials: config.requestCredentials,
      });
    };

    // Create auth HTTP client
    const authBaseUrl = config.authBaseUrl || nodeBaseUrl;
    const authHttpClient = createHttpClientWithToken(authBaseUrl);
    const authApiClient = createAuthApiClientFromHttpClient(authHttpClient, {
      baseUrl: authBaseUrl,
      getAuthToken: getTokenFromStorage,
      timeoutMs: config.timeoutMs,
    });

    // Create node HTTP client (admin API)
    const nodeBaseUrlWithAdmin = `${nodeBaseUrl}/admin-api`;
    const nodeHttpClient = createHttpClientWithToken(nodeBaseUrlWithAdmin);
    const nodeApiClient = createAdminApiClientFromHttpClient(nodeHttpClient, {
      baseUrl: nodeBaseUrlWithAdmin,
      getAuthToken: getTokenFromStorage,
      timeoutMs: config.timeoutMs,
    });

    // Create MeroJs instances for compatibility (they won't be used directly)
    // but we need them for the API wrappers
    const authMeroJs = {
      auth: authApiClient,
      admin: nodeApiClient,
    } as any as MeroJs;

    const nodeMeroJs = {
      auth: authApiClient,
      admin: nodeApiClient,
    } as any as MeroJs;

    this.auth = new AuthApi(authMeroJs, nodeMeroJs, config);
    this.node = new NodeApi(nodeMeroJs, nodeBaseUrlWithAdmin);
  }
}

export function createClient(config: ClientConfig): Client {
  const client = new Client(config);
  // Update global singleton via import
  import('./singleton').then(({ setClientInstance }) => {
    setClientInstance(client);
  });
  return client;
}

export type { ClientConfig };

