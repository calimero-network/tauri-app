import { test, expect } from "@playwright/test";
import {
  seedSettings,
  seedAuthTokens,
  clearAllStorage,
  mockCoreAPIs,
  setupAuthenticatedPage,
} from "./fixtures/helpers";
import {
  STORAGE_KEYS,
  AUTHENTICATED_SETTINGS,
  MOCK_ACCESS_TOKEN,
  MOCK_REFRESH_TOKEN,
  MOCK_PROVIDERS,
  MOCK_TOKEN_RESPONSE,
  API_ROUTES,
} from "./fixtures/mock-data";

test.describe("Login screen display", () => {
  test("shows login screen when authenticated tokens are missing", async ({
    page,
  }) => {
    const settings = {
      ...AUTHENTICATED_SETTINGS,
      onboardingCompleted: true,
    };

    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: "OK" }) })
    );
    await page.route(API_ROUTES.providers, (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ data: MOCK_PROVIDERS }),
      })
    );
    await page.route(API_ROUTES.installedApps, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );
    await page.route(API_ROUTES.contexts, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );

    await page.addInitScript(
      (s) => {
        localStorage.setItem("calimero-desktop-settings", JSON.stringify(s));
      },
      settings
    );
    await page.goto("/");

    await expect(page.locator(".login-screen")).toBeVisible({ timeout: 10000 });
  });

  test("login screen has Settings button", async ({ page }) => {
    const settings = {
      ...AUTHENTICATED_SETTINGS,
      onboardingCompleted: true,
    };

    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: "OK" }) })
    );
    await page.route(API_ROUTES.providers, (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ data: MOCK_PROVIDERS }),
      })
    );
    await page.route(API_ROUTES.installedApps, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );
    await page.route(API_ROUTES.contexts, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );

    await page.addInitScript(
      (s) => {
        localStorage.setItem("calimero-desktop-settings", JSON.stringify(s));
      },
      settings
    );
    await page.goto("/");

    await expect(page.locator(".login-screen")).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator(".login-screen-header button", { hasText: "Settings" })
    ).toBeVisible();
  });
});

test.describe("Authenticated user bypass", () => {
  test("skips login and shows main app when tokens exist", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    await expect(page.locator(".login-screen")).not.toBeVisible();
    await expect(
      page.locator("text=Welcome to Calimero Desktop")
    ).toBeVisible();
  });

  test("access token is stored in localStorage after setup", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    const token = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.accessToken
    );
    expect(token).toBe(MOCK_ACCESS_TOKEN);
  });

  test("refresh token is stored in localStorage after setup", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    const token = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.refreshToken
    );
    expect(token).toBe(MOCK_REFRESH_TOKEN);
  });
});

test.describe("401 redirect to login", () => {
  test("redirects to login when health check returns 401", async ({
    page,
  }) => {
    const settings = {
      ...AUTHENTICATED_SETTINGS,
      onboardingCompleted: true,
    };

    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({
          error: { message: "Unauthorized", code: "401" },
        }),
      })
    );
    await page.route(API_ROUTES.providers, (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ data: MOCK_PROVIDERS }),
      })
    );
    await page.route(API_ROUTES.installedApps, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );
    await page.route(API_ROUTES.contexts, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );

    await page.addInitScript(
      ([s, accessKey, accessVal, refreshKey, refreshVal, expiresKey]) => {
        localStorage.setItem("calimero-desktop-settings", JSON.stringify(s));
        localStorage.setItem(accessKey as string, accessVal as string);
        localStorage.setItem(refreshKey as string, refreshVal as string);
        localStorage.setItem(
          expiresKey as string,
          String(Date.now() + 3600000)
        );
      },
      [
        settings,
        STORAGE_KEYS.accessToken,
        MOCK_ACCESS_TOKEN,
        STORAGE_KEYS.refreshToken,
        MOCK_REFRESH_TOKEN,
        STORAGE_KEYS.tokenExpires,
      ] as const
    );
    await page.goto("/");

    await expect(page.locator(".login-screen")).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Node disconnected state", () => {
  test("shows disconnected status when node health fails", async ({
    page,
  }) => {
    const settings = {
      ...AUTHENTICATED_SETTINGS,
      onboardingCompleted: true,
    };

    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({
          error: { message: "Node not responding" },
        }),
      })
    );
    await page.route(API_ROUTES.installedApps, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );
    await page.route(API_ROUTES.contexts, (route) =>
      route.fulfill({ status: 200, body: JSON.stringify({ data: [] }) })
    );

    await page.addInitScript(
      ([s, accessKey, accessVal, refreshKey, refreshVal, expiresKey]) => {
        localStorage.setItem("calimero-desktop-settings", JSON.stringify(s));
        localStorage.setItem(accessKey as string, accessVal as string);
        localStorage.setItem(refreshKey as string, refreshVal as string);
        localStorage.setItem(
          expiresKey as string,
          String(Date.now() + 3600000)
        );
      },
      [
        settings,
        STORAGE_KEYS.accessToken,
        MOCK_ACCESS_TOKEN,
        STORAGE_KEYS.refreshToken,
        MOCK_REFRESH_TOKEN,
        STORAGE_KEYS.tokenExpires,
      ] as const
    );
    await page.goto("/");

    await expect(page.locator(".status-badge.disconnected")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("text=Disconnected")).toBeVisible();
  });
});
