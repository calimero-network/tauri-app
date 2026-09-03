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

/**
 * The token pair the node mints on the Nth rotation of a token family.
 *
 * Refresh tokens are single-use (calimero-network/core#3083): each
 * POST /auth/refresh consumes the presented refresh token and returns a brand
 * new pair, so no two generations share a token. Access tokens stay JWT-shaped
 * because mero-js reads `exp` out of the payload to compute `expires_at`.
 */
export function rotatedTokenPair(generation: number): {
  access_token: string;
  refresh_token: string;
} {
  const signature = `${JWT_SIGNATURE}-r${generation}`;
  return {
    access_token: `${JWT_HEADER}.${JWT_PAYLOAD}.${signature}`,
    refresh_token: `refresh-${JWT_HEADER}.${JWT_PAYLOAD}.${signature}`,
  };
}

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

// ─── Marketplace / Registry (V2 bundle API) ───────────────────────────────────
// `fetchAppsFromRegistry` / `fetchAppManifest` expect V2 bundle objects
// (`package`, `appVersion`, `wasm`, `metadata`, `signature`, `downloads`, …).

export const MOCK_REGISTRY_V2_BUNDLES = [
  {
    package: "only-peers-chat",
    appVersion: "0.3.0",
    minRuntimeVersion: "1.0.0",
    version: "2.0",
    wasm: { hash: "deadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedeadbeefcafedead", path: "", size: 12345 },
    metadata: {
      name: "Only Peers Chat",
      description: "Decentralized chat application",
      author: "dev1.testnet",
    },
    signature: {
      pubkey: "dev1.testnet",
      alg: "ed25519",
      sig: "aa",
      signedAt: "2025-01-01T00:00:00.000Z",
    },
    downloads: 42,
    interfaces: { exports: [] as string[], uses: [] as string[] },
    links: {},
  },
  {
    package: "blockchain-demo",
    appVersion: "1.0.0",
    minRuntimeVersion: "1.0.0",
    version: "2.0",
    wasm: { hash: "beefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead", size: 9999 },
    metadata: {
      name: "Blockchain Demo",
      description: "Simple blockchain demo application",
      author: "dev2.testnet",
    },
    signature: {
      pubkey: "dev2.testnet",
      alg: "ed25519",
      sig: "bb",
      signedAt: "2025-02-01T00:00:00.000Z",
    },
    downloads: 10,
    interfaces: { exports: [] as string[], uses: [] as string[] },
    links: {},
  },
] as const;

/** Rows aligned with UI after `fetchAppsFromRegistry` mapping (for assertions). */
export const MOCK_REGISTRY_APPS = MOCK_REGISTRY_V2_BUNDLES.map((b) => ({
  id: b.package,
  name: b.package,
  alias: b.metadata.name,
  developer_pubkey: b.signature.pubkey,
  latest_version: b.appVersion,
  description: b.metadata.description,
  download_count: b.downloads,
}));

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

// ─── Node identity (GET /admin-api/identity) ────────────────────────────────

export const MOCK_NODE_IDENTITY = {
  accountId: "a".repeat(64),
  deviceId: "d".repeat(32),
  publicKey: "EdMockDevicePublicKey11111111111111111111111",
  accountRootPublicKey: "c".repeat(64),
};

// ─── Device pairing ─────────────────────────────────────────────────────────

export const MOCK_NAMESPACE_ID = "ns-1";
export const MOCK_OTHER_NAMESPACE_ID = "ns-2";
export const MOCK_APPLICATION_ID = "cafe111111111111111111111111111111111111111111111111111111111111";
export const MOCK_OTHER_APPLICATION_ID = "face222222222222222222222222222222222222222222222222222222222222";

/** Two namespaces targeting two different apps, so scoping can narrow an invite. */
export const MOCK_NAMESPACES = [
  {
    namespaceId: MOCK_NAMESPACE_ID,
    name: "Personal",
    targetApplicationId: MOCK_APPLICATION_ID,
  },
  {
    namespaceId: MOCK_OTHER_NAMESPACE_ID,
    name: "Files",
    targetApplicationId: MOCK_OTHER_APPLICATION_ID,
  },
];

export const MOCK_ACCOUNT_APPLICATIONS = [
  { applicationId: MOCK_APPLICATION_ID, namespaces: [MOCK_NAMESPACE_ID] },
  { applicationId: MOCK_OTHER_APPLICATION_ID, namespaces: [MOCK_OTHER_NAMESPACE_ID] },
];

export const MOCK_PAIR_INIT = {
  accountId: MOCK_NODE_IDENTITY.accountId,
  deviceId: "b".repeat(64),
  kemPublicKey: "c".repeat(64),
  signPublicKey: "d".repeat(64),
  statement: "e".repeat(128),
  confirmationCode: "7BC0-DAAC",
};

export const MOCK_PAIR_COMPLETE = {
  accountId: MOCK_PAIR_INIT.accountId,
  deviceId: MOCK_PAIR_INIT.deviceId,
  keyDelivered: true,
  confirmationCode: MOCK_PAIR_INIT.confirmationCode,
};

/** An empty `applications` is core's "every application", which is what this
 *  node's own device always has. */
export const MOCK_ACCOUNT_DEVICES = [
  {
    deviceId: MOCK_NODE_IDENTITY.deviceId,
    signingKey: "ed01333333333333333333333333333333333333333333333333333333333333",
    isSelf: true,
    revoked: false,
    applications: [],
    namespaces: [MOCK_NAMESPACE_ID, MOCK_OTHER_NAMESPACE_ID],
  },
  {
    deviceId: MOCK_PAIR_INIT.deviceId,
    signingKey: "ed02444444444444444444444444444444444444444444444444444444444444",
    isSelf: false,
    revoked: false,
    applications: [MOCK_APPLICATION_ID],
    namespaces: [MOCK_NAMESPACE_ID],
  },
];

export const MOCK_RELINK = {
  accountId: MOCK_NODE_IDENTITY.accountId,
  deviceId: MOCK_PAIR_INIT.deviceId,
  applications: [MOCK_APPLICATION_ID],
  linkedIn: [{ namespaceId: MOCK_NAMESPACE_ID, keyDelivered: true }],
  skipped: [{ namespaceId: MOCK_OTHER_NAMESPACE_ID, reason: "outOfScope" }],
};

export const MOCK_REVOKE = {
  accountId: MOCK_NODE_IDENTITY.accountId,
  deviceId: MOCK_PAIR_INIT.deviceId,
  keyRotated: true,
  revokedIn: [{ namespaceId: MOCK_NAMESPACE_ID, keyRotated: true }],
};

export const MOCK_PAIR_INVITE_BLOB =
  "mero-pair:" +
  btoa(
    JSON.stringify({
      rootKey: MOCK_NODE_IDENTITY.accountRootPublicKey,
      namespaces: [MOCK_NAMESPACE_ID, MOCK_OTHER_NAMESPACE_ID],
      // Registry coordinates, as a holder's invite carries them.
      apps: [{ package: "com.calimero.chat", version: "3.1.1" }],
    }),
  );

/** The new device's answer. The confirmation code is deliberately not in it. */
export const MOCK_PAIR_REPLY_BLOB =
  "mero-pair-reply:" +
  btoa(
    JSON.stringify({
      deviceId: MOCK_PAIR_INIT.deviceId,
      kemPublicKey: MOCK_PAIR_INIT.kemPublicKey,
      signPublicKey: MOCK_PAIR_INIT.signPublicKey,
      statement: MOCK_PAIR_INIT.statement,
    }),
  );

// ─── API route patterns (for page.route()) ───────────────────────────────────

export const API_ROUTES = {
  health: "**/auth/health",
  adminHealth: "**/admin-api/health",
  providers: "**/auth/providers",
  requestToken: "**/auth/request-token",
  // The node's route is `/auth/refresh` (mero-js posts there). This used to read
  // `**/auth/refresh-token`, which matched nothing — the refresh path was
  // effectively untested and every refresh request escaped the mock.
  refreshToken: "**/auth/refresh",
  listApplications: "**/admin-api/applications",
  installApplication: "**/admin-api/install-application",
  uninstallApplication: "**/admin-api/applications/*",
  identity: "**/admin-api/identity",
  // Trailing `*` for the explicit `?limit=`; `*` stops at `/`, so this still
  // does not swallow the namespace-scoped routes below it.
  namespaces: "**/admin-api/namespaces*",
  accountDevices: "**/admin-api/account/devices",
  accountApplications: "**/admin-api/account/applications",
  relinkDevice: "**/admin-api/account/devices/*/relink",
  revokeDevice: "**/admin-api/namespaces/*/account/revoke",
  pairInit: "**/admin-api/account/pair-init",
  pairComplete: "**/admin-api/account/pair-complete",
  listContexts: "**/admin-api/contexts",
  createContext: "**/admin-api/contexts",
  deleteContext: "**/admin-api/contexts/*",
  registryBundles: "**/api/v2/bundles",
  registryDownloadsRecord: "**/api/v2/downloads/record",
} as const;
