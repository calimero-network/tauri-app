import type { Locator, Page } from "@playwright/test";
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
  MOCK_REGISTRY_V2_BUNDLES,
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

// ─── Tauri IPC stub ──────────────────────────────────────────────────────────

/**
 * Stub `window.__TAURI_IPC__` so that `invoke()` from `@tauri-apps/api/tauri`
 * resolves immediately instead of throwing a TypeError in the browser context.
 * Must be called **before** the page navigates to the app.
 */
export async function stubTauriIPC(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__TAURI_IPC__ = ({
      callback,
    }: {
      cmd: string;
      callback: number;
      error: number;
    }) => {
      // Resolve every invoke call with an empty/successful response.
      const cb = (window as any)[`_${callback}`];
      if (typeof cb === "function") {
        cb(null);
      }
    };
  });
}

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
  await page.evaluate(() => {
    localStorage.setItem("calimero-autostart-default-applied", "1");
  });
}

/**
 * Seeds localStorage for authenticated + developer mode enabled.
 */
export async function seedDeveloperState(page: Page): Promise<void> {
  await seedSettings(page, DEVELOPER_SETTINGS);
  await seedAuthTokens(page);
  await page.evaluate(() => {
    localStorage.setItem("calimero-autostart-default-applied", "1");
  });
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
 * Mock registry V2 bundle API: list, ?package= filter, and GET /bundles/:package/:version.
 * Matches `fetchAppsFromRegistry`, `fetchAppVersions`, `fetchAppManifest` in registry.ts.
 */
export async function mockRegistryAPIs(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.includes("/api/v2/bundles"),
    async (route) => {
      if (route.request().method() !== "GET") {
        return route.continue();
      }
      const url = new URL(route.request().url());
      const parts = url.pathname.split("/").filter(Boolean);
      const bi = parts.indexOf("bundles");
      const rest = bi >= 0 ? parts.slice(bi + 1) : [];

      if (rest.length === 0) {
        const pkg = url.searchParams.get("package");
        const list = pkg
          ? MOCK_REGISTRY_V2_BUNDLES.filter((b) => b.package === pkg)
          : [...MOCK_REGISTRY_V2_BUNDLES];
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(list),
        });
      }

      if (rest.length === 2) {
        const [pkg, ver] = rest;
        const b = MOCK_REGISTRY_V2_BUNDLES.find(
          (x) => x.package === pkg && x.appVersion === ver,
        );
        if (!b) {
          return route.fulfill({ status: 404, body: "not found" });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(b),
        });
      }

      return route.continue();
    },
  );

  await page.route(API_ROUTES.registryDownloadsRecord, (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    }
    return route.continue();
  });
}

/**
 * Mock install/uninstall endpoints to return success.
 */
export async function mockInstallAPIs(page: Page): Promise<void> {
  await page.route(API_ROUTES.installApplication, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { applicationId: "mock-installed-app-" + Date.now() },
      }),
    }),
  );

  await page.route(API_ROUTES.uninstallApplication, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { success: true } }),
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

/** Max time for post-reload init: node health (3s race) + checkOnboardingState (10s race). */
const APP_SHELL_TIMEOUT_MS = 30_000;

/**
 * Wait until the main shell (sidebar) is visible. After `page.reload()`, the app shows
 * "Setting up Calimero Desktop" until `checkingOnboarding` clears — that can exceed Playwright's
 * default 5s expect timeout if onboarding checks are slow.
 */
export async function waitForAppShellReady(
  page: Page,
  timeout = APP_SHELL_TIMEOUT_MS,
): Promise<void> {
  await Promise.all([
    page.locator("aside.sidebar").waitFor({ state: "visible", timeout }),
    page
      .getByTestId("shell-page-title")
      .waitFor({ state: "visible", timeout }),
  ]);
}

/**
 * Scroll a control into view inside the Settings page's nested `.settings-main` region.
 * Playwright does not scroll `overflow: auto` ancestors when only the window scrolls.
 *
 * We avoid `scrollIntoViewIfNeeded()` here: controls below the fold are often treated as
 * not visible while clipped, so Playwright times out waiting for visibility before scrolling.
 * `scrollIntoView` via `evaluate` runs on an attached node and scrolls the correct ancestor.
 */
export async function scrollSettingsControlIntoView(
  page: Page,
  target: string | Locator,
): Promise<void> {
  await page.locator(".settings-main").waitFor({ state: "visible" });
  const loc = typeof target === "string" ? page.locator(target) : target;
  await loc.waitFor({ state: "attached" });
  await loc.evaluate((el) => {
    (el as HTMLElement).scrollIntoView({
      block: "center",
      inline: "nearest",
    });
  });
}

export async function navigateVia(
  page: Page,
  label: "Home" | "Nodes" | "Contexts" | "Applications" | "Marketplace",
): Promise<void> {
  await waitForAppShellReady(page);
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
export async function setupAuthenticatedPage(
  page: Page,
  options?: MockCoreAPIsOptions,
): Promise<void> {
  await stubTauriIPC(page);
  await mockCoreAPIs(page, options);
  await page.goto("/");
  await seedAuthenticatedState(page);
  await page.reload();
  await waitForAppShellReady(page);
}

/**
 * Full setup for developer mode (authenticated + developer features visible).
 */
export async function setupDeveloperPage(
  page: Page,
  options?: MockCoreAPIsOptions,
): Promise<void> {
  await stubTauriIPC(page);
  await mockCoreAPIs(page, options);
  await mockContextAPIs(page);
  await page.goto("/");
  await seedDeveloperState(page);
  await page.reload();
  await waitForAppShellReady(page);
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
  await stubTauriIPC(page);
  await mockCoreAPIs(page);
  await page.goto("/");
  await seedAuthenticatedState(page);
  await page.reload();
  await waitForAppShellReady(page);
}

/**
 * Setup for an authenticated page where the node is unreachable / disconnected.
 * The health endpoint returns 503, all other core routes are still mocked so the
 * app doesn't hang on unrelated requests.
 */
export async function setupDisconnectedPage(page: Page): Promise<void> {
  await stubTauriIPC(page);
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
  await page.evaluate(() => {
    localStorage.setItem("calimero-autostart-default-applied", "1");
  });
  await page.reload();
  await waitForAppShellReady(page);
}

/**
 * Setup for an authenticated page with embedded-node settings seeded.
 */
export async function setupEmbeddedNodePage(page: Page): Promise<void> {
  await stubTauriIPC(page);
  await mockCoreAPIs(page);
  await page.goto("/");
  await seedSettings(page, EMBEDDED_NODE_SETTINGS);
  await seedAuthTokens(page);
  await page.evaluate(() => {
    localStorage.setItem("calimero-autostart-default-applied", "1");
  });
  await page.reload();
  await waitForAppShellReady(page);
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
