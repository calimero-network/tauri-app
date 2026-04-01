import type { Page } from "@playwright/test";

// ─── localStorage keys ───────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  settings: "calimero-desktop-settings",
  onboardingProgress: "calimero-onboarding-progress",
  accessToken: "calimero_access_token",
  refreshToken: "calimero_refresh_token",
  tokenExpiresAt: "calimero_token_expires_at",
  appEndpoint: "calimero_app_endpoint",
} as const;

// ─── Default settings (mirrors src/utils/settings.ts) ───────────────────────

export const DEFAULT_NODE_URL = "http://localhost:2528";
export const DEFAULT_REGISTRY_URL = "https://apps.calimero.network/";

export interface AppSettings {
  nodeUrl: string;
  authUrl?: string;
  registries?: string[];
  useEmbeddedNode?: boolean;
  embeddedNodePort?: number;
  embeddedNodeDataDir?: string;
  embeddedNodeName?: string;
  developerMode?: boolean;
  debugLogs?: boolean;
  onboardingCompleted?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  nodeUrl: DEFAULT_NODE_URL,
  registries: [DEFAULT_REGISTRY_URL],
  onboardingCompleted: false,
};

export const AUTHENTICATED_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  onboardingCompleted: true,
};

export const DEVELOPER_SETTINGS: AppSettings = {
  ...AUTHENTICATED_SETTINGS,
  developerMode: true,
};

// ─── Fake JWT token (base64-encoded payload with far-future exp) ─────────────

const JWT_HEADER = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const JWT_PAYLOAD = btoa(
  JSON.stringify({
    sub: "test_user",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400,
  }),
);
const JWT_SIGNATURE = "test-signature";

export const MOCK_ACCESS_TOKEN = `${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIGNATURE}`;
export const MOCK_REFRESH_TOKEN = `refresh-${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIGNATURE}`;
export const MOCK_TOKEN_EXPIRES_AT = Date.now() + 86400 * 1000;

// ─── Auth providers ──────────────────────────────────────────────────────────

export const MOCK_PROVIDERS = [
  {
    id: "user_password",
    name: "user_password",
    enabled: true,
    description: "Username/Password",
  },
];

export const MOCK_PROVIDERS_RESPONSE = {
  data: {
    providers: MOCK_PROVIDERS,
    count: MOCK_PROVIDERS.length,
  },
};

export const MOCK_TOKEN_RESPONSE = {
  data: {
    access_token: MOCK_ACCESS_TOKEN,
    refresh_token: MOCK_REFRESH_TOKEN,
  },
};

// ─── Marketplace / Registry apps ─────────────────────────────────────────────

export const MOCK_REGISTRY_APPS = [
  {
    id: "app-1",
    name: "only-peers-chat",
    alias: "Only Peers Chat",
    developer_pubkey: "dev1.testnet",
    latest_version: "0.3.0",
    description: "Decentralized chat application",
    repository: "https://github.com/example/chat",
    download_count: 42,
    category: "Social",
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-06-01T00:00:00Z",
  },
  {
    id: "app-2",
    name: "blockchain-demo",
    alias: "Blockchain Demo",
    developer_pubkey: "dev2.testnet",
    latest_version: "1.0.0",
    description: "Simple blockchain demo application",
    repository: "https://github.com/example/demo",
    download_count: 10,
    category: "Utilities",
    created_at: "2025-02-01T00:00:00Z",
    updated_at: "2025-05-01T00:00:00Z",
  },
];

export const MOCK_APP_MANIFEST = {
  name: "only-peers-chat",
  version: "0.3.0",
  metadata: {
    name: "Only Peers Chat",
    description: "Decentralized chat application",
    repository: "https://github.com/example/chat",
  },
  source: {
    url: "https://apps.calimero.network/bundles/app-1/0.3.0.wasm",
    hash: "abc123",
  },
};

// ─── Installed applications ──────────────────────────────────────────────────

export const MOCK_INSTALLED_APPS = [
  {
    id: "installed-app-1",
    name: "only-peers-chat",
    version: "0.3.0",
    metadata: btoa(
      JSON.stringify({
        name: "Only Peers Chat",
        description: "Decentralized chat",
        links: { frontend: "http://localhost:3001" },
      }),
    ),
    source: "registry",
  },
  {
    id: "installed-app-2",
    name: "blockchain-demo",
    version: "1.0.0",
    metadata: btoa(
      JSON.stringify({
        name: "Blockchain Demo",
        description: "Simple demo",
      }),
    ),
    source: "registry",
  },
];

// ─── Contexts ────────────────────────────────────────────────────────────────

export const MOCK_CONTEXTS = [
  {
    id: "ctx-001-abcdef1234567890",
    name: "Test Context Alpha",
    application_id: "installed-app-1",
    protocol: "near",
    created_at: "2025-03-01T12:00:00Z",
  },
  {
    id: "ctx-002-1234567890abcdef",
    name: "Test Context Beta",
    application_id: "installed-app-2",
    protocol: "near",
    created_at: "2025-04-15T08:30:00Z",
  },
];

/** Row shapes used by Playwright route mocks (same as `MOCK_INSTALLED_APPS` / `MOCK_CONTEXTS`). */
export type MockInstalledAppRow = (typeof MOCK_INSTALLED_APPS)[number];
export type MockContextRow = (typeof MOCK_CONTEXTS)[number];

/**
 * JSON body for `GET .../admin-api/applications`.
 * mero-js unwraps `{ data: T }`; the typed admin client expects `{ apps: Application[] }`.
 */
export function listApplicationsWireBody(apps: MockInstalledAppRow[]): string {
  return JSON.stringify({
    data: {
      apps: apps.map((app) => ({
        applicationId: app.id,
        name: app.name,
        version: app.version,
        metadata: app.metadata,
        source: app.source,
      })),
    },
  });
}

/**
 * JSON body for `GET .../admin-api/contexts`.
 * mero-js expects `{ contexts: Context[] }` after unwrap.
 */
export function listContextsWireBody(rows: MockContextRow[]): string {
  return JSON.stringify({
    data: {
      contexts: rows.map((c) => ({
        id: c.id,
        name: c.name,
        applicationId: c.application_id,
        protocol: c.protocol,
        created_at: c.created_at,
      })),
    },
  });
}

// ─── Health check response ───────────────────────────────────────────────────

export const MOCK_HEALTH_OK = { data: { status: "ok" } };
export const MOCK_HEALTH_UNREACHABLE = {
  error: { message: "Connection refused" },
};

// ─── Embedded-node settings presets ─────────────────────────────────────────

export const EMBEDDED_NODE_SETTINGS: AppSettings = {
  ...AUTHENTICATED_SETTINGS,
  useEmbeddedNode: true,
  embeddedNodeName: "test-node",
  embeddedNodePort: 2528,
  embeddedNodeDataDir: "~/.calimero",
};

export const DISCONNECTED_SETTINGS: AppSettings = {
  ...AUTHENTICATED_SETTINGS,
};

// ─── API route patterns (for page.route()) ───────────────────────────────────

export const API_ROUTES = {
  health: "**/auth/health",
  adminHealth: "**/admin-api/health",
  providers: "**/auth/providers",
  requestToken: "**/auth/request-token",
  refreshToken: "**/auth/refresh-token",
  listApplications: "**/admin-api/applications",
  installApplication: "**/admin-api/install-application",
  uninstallApplication: "**/admin-api/applications/*",
  listContexts: "**/admin-api/contexts",
  createContext: "**/admin-api/contexts",
  deleteContext: "**/admin-api/contexts/*",
  registryBundles: "**/api/v2/bundles",
  registryBundleManifest: "**/api/v2/bundles/*/versions/*/manifest",
  registryDownload: "**/api/v2/bundles/*/download",
} as const;
