/**
 * Thin adapter around MeroJs from @calimero-network/mero-js.
 *
 * Intentionally unversioned: this line read "@1.4.0" while the app was pinned
 * at 2.2.1, and then at 13.x. package.json is the only place a version is
 * worth stating, because it is the only one anything checks.
 *
 * Provides the same apiClient.auth.* / apiClient.node.* surface the desktop
 * app relies on, while the Namespaces page uses mero-react hooks directly.
 */
import {
  AuthRevokedError,
  HTTPError,
  MeroJs,
  type TokenStore,
  type TokenData,
  type Application,
} from '@calimero-network/mero-js';

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

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

export interface ClientConfig {
  baseUrl: string;
  authBaseUrl?: string;
  requestCredentials?: RequestCredentials;
  timeoutMs?: number;
}

/**
 * Every wrapper answers with `{ data }` or `{ error }` instead of throwing, so
 * one place turns a rejection into the shape a caller reads. `code` is what
 * distinguishes "sign in again" from any other failure.
 */
async function wrap<T>(label: string, call: () => Promise<T>): Promise<ApiResponse<T>> {
  try {
    return { data: await call() };
  } catch (e) {
    if (e instanceof AuthRevokedError) {
      return { error: { message: 'Session revoked', code: '401' } };
    }
    if (e instanceof HTTPError && e.status === 401) {
      return { error: { message: 'Unauthorized', code: '401' } };
    }
    return { error: { message: e instanceof Error ? e.message : label } };
  }
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

  getHealth(): Promise<ApiResponse<{ status: string }>> {
    return wrap('Failed to get auth health', async () => ({
      status: (await this.meroJs.auth.getHealth()).status,
    }));
  }

  getProviders(): Promise<ApiResponse<{ providers: Provider[]; count: number }>> {
    return wrap('Failed to get providers', async () => {
      const r = await this.meroJs.auth.getProviders();
      const providers = (r.providers || []).map((p: any) => ({
        id: p.id ?? p.name,
        name: p.name,
        enabled: p.enabled ?? p.configured ?? false,
        type: p.name,
        description: p.description ?? '',
        configured: p.enabled ?? p.configured ?? false,
      }));
      return { providers, count: r.count ?? providers.length };
    });
  }

  requestToken(payload: {
    auth_method: string;
    public_key: string;
    client_name: string;
    timestamp: number;
    permissions: string[];
    provider_data?: Record<string, unknown>;
  }): Promise<ApiResponse<TokenResponse>> {
    return wrap('Failed to request token', async () => {
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
        throw new Error(r.error ?? r.data?.error ?? 'Failed to generate tokens');
      }
      // 0 asks the SDK to read `exp` off the JWT, falling back to an hour out.
      this.meroJs.setTokenData({ access_token: at, refresh_token: rt, expires_at: 0 });
      return { access_token: at, refresh_token: rt };
    });
  }

  refreshToken(payload: {
    access_token: string;
    refresh_token: string;
  }): Promise<ApiResponse<TokenResponse>> {
    return wrap('Failed to refresh token', async () => {
      const r = await this.meroJs.auth.refreshToken({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });
      const at = r.data?.access_token;
      const rt = r.data?.refresh_token;
      if (!at || !rt) throw new Error('Failed to refresh token');
      this.meroJs.setTokenData({ access_token: at, refresh_token: rt, expires_at: 0 });
      return { access_token: at, refresh_token: rt };
    });
  }
}

// ─── Node API wrapper (flat admin API surface) ──────────────────────────────

class NodeApi {
  constructor(private meroJs: MeroJs) {}

  healthCheck(): Promise<ApiResponse<{ status: string }>> {
    return wrap('Failed to check health', async () => ({
      status: (await this.meroJs.admin.healthCheck()).status,
    }));
  }

  getContexts(): Promise<ApiResponse<any[]>> {
    return wrap('Failed to get contexts', async () =>
      (await this.meroJs.admin.getContexts()).contexts ?? [],
    );
  }

  listApplications(): Promise<ApiResponse<Application[]>> {
    return wrap('Failed to list applications', async () => {
      const { apps } = await this.meroJs.admin.listApplications();
      // The node keys these `applicationId` while mero-js types the field as
      // `id`, which is what every consumer here reads.
      return (apps ?? []).map((app: any) => ({ ...app, id: app.id ?? app.applicationId }));
    });
  }

  /** By coordinates: the node resolves them against its own registry and takes
   *  no URL, so a body carrying one is refused outright. */
  installApplication(request: {
    package: string;
    version: string;
  }): Promise<ApiResponse<{ applicationId: string }>> {
    return wrap('Failed to install application', async () => ({
      applicationId: (await this.meroJs.admin.installApplication(request)).applicationId,
    }));
  }

  uninstallApplication(applicationId: string): Promise<ApiResponse<{ applicationId: string }>> {
    return wrap('Failed to uninstall application', async () => {
      await this.meroJs.admin.uninstallApplication(applicationId);
      return { applicationId };
    });
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

export async function createClientAsync(config: ClientConfig): Promise<Client> {
  clientInstance = new Client(config);
  return clientInstance;
}
