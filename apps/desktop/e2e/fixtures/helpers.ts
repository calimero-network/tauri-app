import type { Page } from "@playwright/test";
import {
  STORAGE_KEYS,
  AUTHENTICATED_SETTINGS,
  DEVELOPER_SETTINGS,
  DEFAULT_SETTINGS,
  EMBEDDED_NODE_SETTINGS,
  DISCONNECTED_SETTINGS,
  MOCK_ACCESS_TOKEN,
  MOCK_REFRESH_TOKEN,
  MOCK_TOKEN_EXPIRES_AT,
  MOCK_HEALTH_OK,
  MOCK_HEALTH_UNREACHABLE,
  MOCK_PROVIDERS_RESPONSE,
  MOCK_CONTEXTS,
  MOCK_INSTALLED_APPS,
  MOCK_REGISTRY_APPS,
  API_ROUTES,
  listApplicationsWireBody,
  listContextsWireBody,
  type AppSettings,
  type MockContextRow,
  type MockInstalledAppRow,
} from "./mock-data";

export type MockCoreAPIsOptions = {
  /** Defaults to `[]` (fresh install: no contexts). */
  contexts?: MockContextRow[];
  /** Defaults to `MOCK_INSTALLED_APPS` (non-empty app dropdown for create-context flows). */
  installedApps?: MockInstalledAppRow[];
};

// ─── localStorage seeding ────────────────────────────────────────────────────

export async function seedSettings(
  page: Page,
  settings: AppSettings,
): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    [STORAGE_KEYS.settings, settings] as const,
  );
}

export async function seedAuthTokens(page: Page): Promise<void> {
  await page.evaluate(
    ([accessKey, refreshKey, expiresKey, accessVal, refreshVal, expiresVal]) => {
      localStorage.setItem(accessKey, accessVal);
      localStorage.setItem(refreshKey, refreshVal);
      localStorage.setItem(expiresKey, expiresVal.toString());
    },
    [
      STORAGE_KEYS.accessToken,
      STORAGE_KEYS.refreshToken,
      STORAGE_KEYS.tokenExpiresAt,
      MOCK_ACCESS_TOKEN,
      MOCK_REFRESH_TOKEN,
      MOCK_TOKEN_EXPIRES_AT,
    ] as const,
  );
}

export async function clearAllStorage(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.clear());
}

/**
 * Seeds localStorage so the app skips onboarding and renders the
 * authenticated home page. Call this, then page.goto("/") or reload.
 */
export async function seedAuthenticatedState(page: Page): Promise<void> {
  await seedSettings(page, AUTHENTICATED_SETTINGS);
  await seedAuthTokens(page);
}

/**
 * Seeds localStorage for authenticated + developer mode enabled.
 */
export async function seedDeveloperState(page: Page): Promise<void> {
  await seedSettings(page, DEVELOPER_SETTINGS);
  await seedAuthTokens(page);
}

// ─── API mocking helpers ─────────────────────────────────────────────────────

/**
 * Intercept common backend routes so the app doesn't hang on network calls.
 * Call this before page.goto("/") for any post-onboarding test.
 */
export async function mockCoreAPIs(
  page: Page,
  options?: MockCoreAPIsOptions,
): Promise<void> {
  const contexts = options?.contexts ?? [];
  const installedApps = options?.installedApps ?? MOCK_INSTALLED_APPS;

  await page.route(API_ROUTES.health, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_HEALTH_OK) }),
  );

  await page.route(API_ROUTES.adminHealth, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_HEALTH_OK) }),
  );

  await page.route(API_ROUTES.providers, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_PROVIDERS_RESPONSE) }),
  );

  await page.route(API_ROUTES.listApplications, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: listApplicationsWireBody(installedApps),
    }),
  );

  await page.route(API_ROUTES.listContexts, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: listContextsWireBody(contexts),
      });
    }
    return route.continue();
  });
}

/**
 * Mock registry endpoints so the Marketplace page can render apps.
 */
export async function mockRegistryAPIs(page: Page): Promise<void> {
  await page.route(API_ROUTES.registryBundles, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_REGISTRY_APPS),
    }),
  );
}

/**
 * Mock install/uninstall endpoints to return success.
 */
export async function mockInstallAPIs(page: Page): Promise<void> {
  await page.route(API_ROUTES.installApplication, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { success: true } }),
    }),
  );

  await page.route(API_ROUTES.uninstallApplication, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { success: true } }),
    }),
  );

  await page.route(API_ROUTES.registryBundleManifest, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        name: "only-peers-chat",
        version: "0.3.0",
        metadata: { name: "Only Peers Chat" },
        source: {
          url: "https://apps.calimero.network/bundles/app-1/0.3.0.wasm",
          hash: "abc123",
        },
      }),
    }),
  );

  await page.route(API_ROUTES.registryDownload, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    }),
  );
}

/**
 * Mock context create / delete endpoints.
 */
export async function mockContextAPIs(page: Page): Promise<void> {
  await page.route(API_ROUTES.createContext, (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            contextId: "ctx-new-" + Date.now(),
            memberPublicKey: "mock-member-pk",
          },
        }),
      });
    }
    // Same glob as listContexts in mockCoreAPIs; fallback chains to that handler.
    return route.fallback();
  });

  await page.route(API_ROUTES.deleteContext, (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { success: true } }),
      });
    }
    return route.continue();
  });
}

// ─── Navigation helpers ──────────────────────────────────────────────────────

export async function navigateVia(
  page: Page,
  label: "Home" | "Nodes" | "Contexts" | "Applications" | "Marketplace",
): Promise<void> {
  await page.locator("aside.sidebar").getByTitle(label).click();
}

// ─── Composite setup helpers ─────────────────────────────────────────────────

/**
 * Full setup for an authenticated user session:
 *   1. mock APIs
 *   2. navigate to the app (establishes origin for localStorage)
 *   3. seed authenticated state
 *   4. reload so the app picks up seeded state
 */
export async function setupAuthenticatedPage(page: Page): Promise<void> {
  await mockCoreAPIs(page);
  await page.goto("/");
  await seedAuthenticatedState(page);
  await page.reload();
}

/**
 * Full setup for developer mode (authenticated + developer features visible).
 */
export async function setupDeveloperPage(
  page: Page,
  options?: MockCoreAPIsOptions,
): Promise<void> {
  await mockCoreAPIs(page, options);
  await mockContextAPIs(page);
  await page.goto("/");
  await seedDeveloperState(page);
  await page.reload();
}

// ─── Node lifecycle helpers ─────────────────────────────────────────────────

/**
 * Mock the health endpoint to return a healthy response.
 */
export async function mockHealthy(page: Page): Promise<void> {
  await page.route(API_ROUTES.health, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_HEALTH_OK),
    }),
  );

  await page.route(API_ROUTES.adminHealth, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_HEALTH_OK),
    }),
  );
}

/**
 * Mock the health endpoint to simulate an unreachable / disconnected node.
 */
export async function mockUnhealthy(page: Page): Promise<void> {
  await page.route(API_ROUTES.health, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify(MOCK_HEALTH_UNREACHABLE),
    }),
  );

  await page.route(API_ROUTES.adminHealth, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify(MOCK_HEALTH_UNREACHABLE),
    }),
  );
}

/**
 * Setup for an authenticated page where the node is healthy / connected.
 */
export async function setupConnectedPage(page: Page): Promise<void> {
  await mockCoreAPIs(page);
  await page.goto("/");
  await seedAuthenticatedState(page);
  await page.reload();
}

/**
 * Setup for an authenticated page where the node is unreachable / disconnected.
 * The health endpoint returns 503, all other core routes are still mocked so the
 * app doesn't hang on unrelated requests.
 */
export async function setupDisconnectedPage(page: Page): Promise<void> {
  await mockUnhealthy(page);

  await page.route(API_ROUTES.providers, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PROVIDERS_RESPONSE),
    }),
  );

  await page.route(API_ROUTES.listApplications, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: listApplicationsWireBody([]),
    }),
  );

  await page.route(API_ROUTES.listContexts, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: listContextsWireBody([]),
    }),
  );

  await page.goto("/");
  await seedSettings(page, DISCONNECTED_SETTINGS);
  await page.reload();
}

/**
 * Setup for an authenticated page with embedded-node settings seeded.
 */
export async function setupEmbeddedNodePage(page: Page): Promise<void> {
  await mockCoreAPIs(page);
  await page.goto("/");
  await seedSettings(page, EMBEDDED_NODE_SETTINGS);
  await seedAuthTokens(page);
  await page.reload();
}

/**
 * Wait until the node status indicator shows the expected connection state.
 */
export async function waitForNodeStatus(
  page: Page,
  state: "connected" | "disconnected",
  timeout = 10_000,
): Promise<void> {
  await page
    .locator(`.node-status-indicator.${state}`)
    .waitFor({ state: "visible", timeout });
}
