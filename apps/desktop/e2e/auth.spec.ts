import { test, expect } from "@playwright/test";
import {
  mockCoreAPIs,
  setupAuthenticatedPage,
  seedSettings,
} from "./fixtures/helpers";
import {
  AUTHENTICATED_SETTINGS,
  MOCK_PROVIDERS_RESPONSE,
  API_ROUTES,
  STORAGE_KEYS,
} from "./fixtures/mock-data";

// ─── Login screen ────────────────────────────────────────────────────────────

test.describe.only("Login screen display", () => {
  test.beforeEach(async ({ page }) => {
    await mockCoreAPIs(page);
    await page.goto("/");
    await seedSettings(page, AUTHENTICATED_SETTINGS);
    await page.reload();
  });

  test("shows login screen when tokens are absent", async ({ page }) => {
    await expect(page.getByTestId("login-screen")).toBeVisible({ timeout: 10_000 });
  });

  test("login screen has a Settings button", async ({ page }) => {
    await expect(page.getByTestId("login-screen")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  });
});

// ─── Authenticated user ──────────────────────────────────────────────────────

test.describe.only("Authenticated user bypass", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("skips login and shows main app", async ({ page }) => {
    await expect(page.getByTestId("login-screen")).not.toBeVisible();
    await expect(page.locator("aside.sidebar")).toBeVisible();
  });
});

// ─── 401 / auth error redirect ───────────────────────────────────────────────

test.describe.only("401 redirect to login", () => {
  test("shows login when health check returns auth error", async ({ page }) => {
    // Return real HTTP 401 so mero-js throws with .status === 401, which the
    // healthCheck wrapper maps to { error: { code: '401' } }, triggering login.
    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );
    await page.route(API_ROUTES.adminHealth, (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );
    // Mock refresh token endpoint so the mero-js retry fails quickly (401 → no further retry)
    await page.route(API_ROUTES.refreshToken, (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }),
    );
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
        body: JSON.stringify({ data: { apps: [] } }),
      }),
    );
    await page.route(API_ROUTES.listContexts, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { contexts: [] } }),
      }),
    );

    await page.goto("/");
    await page.evaluate(
      ([settingsKey, settings, accessKey, refreshKey, expiresKey]) => {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
        localStorage.setItem(accessKey, "mock-access-token");
        localStorage.setItem(refreshKey, "mock-refresh-token");
        localStorage.setItem(expiresKey, String(Date.now() + 3600000));
      },
      [
        STORAGE_KEYS.settings,
        AUTHENTICATED_SETTINGS,
        STORAGE_KEYS.accessToken,
        STORAGE_KEYS.refreshToken,
        STORAGE_KEYS.tokenExpiresAt,
      ] as const,
    );
    await page.reload();

    await expect(page.getByTestId("login-screen")).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Node disconnected state ─────────────────────────────────────────────────

test.describe.only("Node disconnected state", () => {
  test("shows disconnected indicator when node health fails", async ({ page }) => {
    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Node not responding" } }),
      }),
    );
    await page.route(API_ROUTES.adminHealth, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Node not responding" } }),
      }),
    );
    await page.route(API_ROUTES.providers, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_PROVIDERS_RESPONSE),
      }),
    );
    await page.route(API_ROUTES.listApplications, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
    );
    await page.route(API_ROUTES.listContexts, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }),
    );

    await page.goto("/");
    await page.evaluate(
      ([settingsKey, settings, accessKey, refreshKey, expiresKey]) => {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
        localStorage.setItem(accessKey, "mock-access-token");
        localStorage.setItem(refreshKey, "mock-refresh-token");
        localStorage.setItem(expiresKey, String(Date.now() + 3600000));
      },
      [
        STORAGE_KEYS.settings,
        AUTHENTICATED_SETTINGS,
        STORAGE_KEYS.accessToken,
        STORAGE_KEYS.refreshToken,
        STORAGE_KEYS.tokenExpiresAt,
      ] as const,
    );
    await page.reload();

    await expect(page.locator(".node-status-indicator.disconnected")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".node-status-label", { hasText: "Disconnected" })).toBeVisible();
  });
});
