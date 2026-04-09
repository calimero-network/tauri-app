/**
 * Thin adapter around MeroJs from @calimero-network/mero-js@1.4.0.
 *
 * Provides the same apiClient.auth.* / apiClient.node.* surface the desktop
 * app relies on, while the Namespaces page uses mero-react hooks directly.
 */
import { MeroJs, type TokenStore, type TokenData } from '@calimero-network/mero-js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data?: T;
  error?: { message: string; code?: string };
}

export interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  type?: string;
  description?: string;
  configured?: boolean;
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

// ─── Token store (localStorage, individual keys for compat) ─────────────────

class DesktopTokenStore implements TokenStore {
  private readonly AK = 'calimero_access_token';
  private readonly RK = 'calimero_refresh_token';
  private readonly EK = 'calimero_token_expires_at';

  getTokens(): TokenData | null {
    try {
      const at = localStorage.getItem(this.AK);
      const rt = localStorage.getItem(this.RK);
      if (!at || !rt) return null;
      const ea = localStorage.getItem(this.EK);
      return {
        access_token: at,
        refresh_token: rt,
        expires_at: ea ? parseInt(ea, 10) : Date.now() + 3600000,
      };
    } catch {
      return null;
    }
  }

  setTokens(token: TokenData): void {
    localStorage.setItem(this.AK, token.access_token);
    localStorage.setItem(this.RK, token.refresh_token);
    if (token.expires_at) localStorage.setItem(this.EK, token.expires_at.toString());
  }

  clear(): void {
    localStorage.removeItem(this.AK);
    localStorage.removeItem(this.RK);
    localStorage.removeItem(this.EK);
  }
}

// ─── Auth API wrapper ───────────────────────────────────────────────────────

class AuthApi {
  constructor(private meroJs: MeroJs) {}

  async getHealth(): Promise<ApiResponse<{ status: string }>> {
    try {
      const r = await this.meroJs.auth.getHealth();
      return { data: { status: r.status } };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to get auth health' } };
    }
  }

  async getProviders(): Promise<ApiResponse<{ providers: Provider[]; count: number }>> {
    try {
      const r = await this.meroJs.auth.getProviders();
      const list = (r.providers || []).map((p: any) => ({
        id: p.id ?? p.name,
        name: p.name,
        enabled: p.enabled ?? p.configured ?? false,
        type: p.name,
        description: p.description ?? '',
        configured: p.enabled ?? p.configured ?? false,
      }));
      return { data: { providers: list, count: r.count ?? list.length } };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to get providers' } };
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
      const r = await this.meroJs.auth.generateTokens({
        auth_method: payload.auth_method,
        public_key: payload.public_key,
        client_name: payload.client_name,
        timestamp: payload.timestamp,
        provider_data: payload.provider_data || {},
        permissions: payload.permissions,
      });
      const at = r.data?.access_token;
      const rt = r.data?.refresh_token;
      if (!at || !rt) {
        return { error: { message: r.error ?? r.data?.error ?? 'Failed to generate tokens' } };
      }
      let expiresAt: number;
      try {
        const jwt = JSON.parse(atob(at.split('.')[1]));
        expiresAt = jwt.exp * 1000;
      } catch {
        expiresAt = Date.now() + 3600 * 1000;
      }
      this.meroJs.setTokenData({ access_token: at, refresh_token: rt, expires_at: expiresAt });
      return { data: { access_token: at, refresh_token: rt } };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to request token' } };
    }
  }

  async refreshToken(payload: {
    access_token: string;
    refresh_token: string;
  }): Promise<ApiResponse<TokenResponse>> {
    try {
      const r = await this.meroJs.auth.refreshToken({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });
      const at = r.data?.access_token;
      const rt = r.data?.refresh_token;
      if (!at || !rt) {
        return { error: { message: 'Failed to refresh token' } };
      }
      let expiresAt: number;
      try {
        const jwt = JSON.parse(atob(at.split('.')[1]));
        expiresAt = jwt.exp * 1000;
      } catch {
        expiresAt = Date.now() + 3600 * 1000;
      }
      this.meroJs.setTokenData({ access_token: at, refresh_token: rt, expires_at: expiresAt });
      return { data: { access_token: at, refresh_token: rt } };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to refresh token' } };
    }
  }

  async getChallenge(): Promise<ApiResponse<{ challenge: string; nonce: string }>> {
    try {
      const r = await this.meroJs.auth.getChallenge();
      return { data: { challenge: r.challenge, nonce: r.expiresAt } };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to get challenge' } };
    }
  }

  async generateClientKey(payload: {
    context_id: string;
    context_identity: string;
    permissions: string[];
  }): Promise<ApiResponse<{ keyId: string; permissions: string[] }>> {
    try {
      const r = await this.meroJs.auth.generateClientKey({
        keyId: payload.context_id,
        clientName: payload.context_identity,
        permissions: payload.permissions,
      });
      const data = (r as any).data ?? r;
      return { data: { keyId: data.keyId ?? data.key_id ?? '', permissions: data.permissions ?? [] } };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to generate client key' } };
    }
  }
}

// ─── Node API wrapper (flat admin API in mero-js 1.4.0) ────────────────────

class NodeApi {
  constructor(private meroJs: MeroJs) {}

  async healthCheck(): Promise<ApiResponse<{ status: string }>> {
    try {
      const h = await this.meroJs.admin.healthCheck();
      return { data: { status: h.status } };
    } catch (e: any) {
      if (e?.status === 401 || (e instanceof Error && e.message.includes('401'))) {
        return { error: { message: 'Unauthorized', code: '401' } };
      }
      return { error: { message: e instanceof Error ? e.message : 'Failed to check health' } };
    }
  }

  async getContexts(): Promise<ApiResponse<any[]>> {
    try {
      const r = await this.meroJs.admin.getContexts();
      const raw = r as any;
      const rows = Array.isArray(raw) ? raw : raw?.contexts ?? [];
      return { data: rows };
    } catch (e: any) {
      if (e?.status === 401) return { error: { message: 'Unauthorized', code: '401' } };
      return { error: { message: e instanceof Error ? e.message : 'Failed to get contexts' } };
    }
  }

  async createContext(request: {
    protocol: string;
    applicationId: string;
    contextSeed?: string;
    initializationParams: number[];
  }): Promise<ApiResponse<{ contextId: string; memberPublicKey: string }>> {
    try {
      const r = await this.meroJs.admin.createContext(request as any);
      return { data: { contextId: (r as any).contextId, memberPublicKey: (r as any).memberPublicKey } };
    } catch (e: any) {
      if (e?.status === 401) return { error: { message: 'Unauthorized', code: '401' } };
      return { error: { message: e instanceof Error ? e.message : 'Failed to create context' } };
    }
  }

  async deleteContext(contextId: string): Promise<ApiResponse<{ contextId: string }>> {
    try {
      await this.meroJs.admin.deleteContext(contextId);
      return { data: { contextId } };
    } catch (e: any) {
      if (e?.status === 401) return { error: { message: 'Unauthorized', code: '401' } };
      return { error: { message: e instanceof Error ? e.message : 'Failed to delete context' } };
    }
  }

  async fetchContextIdentities(contextId: string): Promise<ApiResponse<string[]>> {
    try {
      const r = await this.meroJs.admin.getContextIdentitiesOwned(contextId);
      return { data: ((r as any).identities || []) as string[] };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to fetch context identities' } };
    }
  }

  async getInstalledApplicationDetails(applicationId: string): Promise<ApiResponse<any>> {
    try {
      const r = await this.meroJs.admin.getApplication(applicationId);
      return { data: r };
    } catch (e) {
      return { error: { message: e instanceof Error ? e.message : 'Failed to get application details' } };
    }
  }

  async listApplications(): Promise<ApiResponse<any[]>> {
    try {
      const r = await this.meroJs.admin.listApplications();
      const raw = r as any;
      const rows: unknown[] = (() => {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
          if (Array.isArray(raw.apps)) return raw.apps;
          if (raw.data && Array.isArray(raw.data)) return raw.data;
          if (raw.data?.apps && Array.isArray(raw.data.apps)) return raw.data.apps;
        }
        return [];
      })();
      const normalized = rows.map((app: any) => ({ ...app, id: app.id ?? app.applicationId }));
      return { data: normalized };
    } catch (e: any) {
      if (e?.status === 401) return { error: { message: 'Unauthorized', code: '401' } };
      return { error: { message: e instanceof Error ? e.message : 'Failed to list applications' } };
    }
  }

  async installApplication(request: {
    url: string;
    hash?: string;
    metadata: number[];
  }): Promise<ApiResponse<{ applicationId: string }>> {
    try {
      const r = await this.meroJs.admin.installApplication(request);
      return { data: { applicationId: (r as any).applicationId } };
    } catch (e: any) {
      if (e?.status === 401) return { error: { message: 'Unauthorized', code: '401' } };
      return { error: { message: e instanceof Error ? e.message : 'Failed to install application' } };
    }
  }

  async uninstallApplication(applicationId: string): Promise<ApiResponse<{ applicationId: string }>> {
    try {
      await this.meroJs.admin.uninstallApplication(applicationId);
      return { data: { applicationId } };
    } catch (e: any) {
      if (e?.status === 401) return { error: { message: 'Unauthorized', code: '401' } };
      return { error: { message: e instanceof Error ? e.message : 'Failed to uninstall application' } };
    }
  }
}

// ─── Client + singleton ─────────────────────────────────────────────────────

export class Client {
  public auth: AuthApi;
  public node: NodeApi;
  public meroJs: MeroJs;

  constructor(config: ClientConfig) {
    const tokenStore = new DesktopTokenStore();
    this.meroJs = new MeroJs({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      requestCredentials: config.requestCredentials ?? 'omit',
      tokenStore,
    });
    // Load existing tokens from localStorage into MeroJs
    const existing = tokenStore.getTokens();
    if (existing) {
      this.meroJs.setTokenData(existing);
    }
    this.auth = new AuthApi(this.meroJs);
    this.node = new NodeApi(this.meroJs);
  }
}

let clientInstance: Client | null = null;

export const apiClient = new Proxy({} as Client, {
  get(_target, prop) {
    if (!clientInstance) {
      clientInstance = new Client({ baseUrl: 'http://localhost:2528' });
    }
    return (clientInstance as any)[prop];
  },
});

export function createClient(config: ClientConfig): Client {
  clientInstance = new Client(config);
  return clientInstance;
}

export async function createClientAsync(config: ClientConfig): Promise<Client> {
  clientInstance = new Client(config);
  return clientInstance;
}

export type { ClientConfig as MeroClientConfig };
