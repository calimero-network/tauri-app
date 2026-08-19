import { test, expect } from "./fixtures/test";
import {
  AUTH_ERROR_HEADERS,
  mockCoreAPIs,
  mockSingleUseRefresh,
  setupAuthenticatedPage,
  seedAuthenticatedState,
  seedSettings,
  stubTauriIPC,
  waitForAppShellReady,
} from "./fixtures/helpers";
import {
  AUTHENTICATED_SETTINGS,
  MOCK_ACCESS_TOKEN,
  MOCK_PROVIDERS_RESPONSE,
  MOCK_REFRESH_TOKEN,
  API_ROUTES,
  STORAGE_KEYS,
  listApplicationsWireBody,
  listContextsWireBody,
} from "./fixtures/mock-data";

// ─── Login screen ────────────────────────────────────────────────────────────

test.describe("Login screen display", () => {
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

test.describe("Authenticated user bypass", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("skips login and shows main app", async ({ page }) => {
    await expect(page.getByTestId("login-screen")).not.toBeVisible();
    await expect(page.locator("aside.sidebar")).toBeVisible();
  });
});

// ─── Single-use refresh tokens (calimero-network/core#3083) ─────────────────
//
// The node consumes the presented refresh token on every POST /auth/refresh and
// mints a new one; re-presenting a consumed token is treated as theft and the
// whole family is revoked. `mockSingleUseRefresh` enforces exactly that, so a
// client that keeps a consumed token — or that shares one with a second holder,
// which is what the desktop used to do by putting it in every app window's URL
// hash — fails here instead of passing against a permissive mock.

test.describe("single-use refresh token rotation", () => {
  test("desktop keeps the rotated refresh token and never replays a consumed one", async ({
    page,
  }) => {
    await stubTauriIPC(page);
    await mockCoreAPIs(page);
    const refresh = await mockSingleUseRefresh(page);

    // Reject the seeded access token as expired, and accept anything else — i.e.
    // behave like a node whose access token has aged out, until the client
    // rotates. Keyed on the presented bearer rather than a call count because
    // unauthenticated probes (onboarding, node detection) also hit this route.
    //
    // The `x-auth-error: token_expired` header is load-bearing: mero-js only
    // auto-refreshes on that exact reason (web-client.js), and only when the
    // node exposes the header cross-origin. Registered after mockCoreAPIs so
    // this handler wins.
    await page.route(API_ROUTES.adminHealth, (route) => {
      const auth = route.request().headers()["authorization"] ?? "";
      const presented = auth.replace(/^Bearer\s+/i, "");
      if (presented === MOCK_ACCESS_TOKEN) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          headers: AUTH_ERROR_HEADERS("token_expired"),
          body: JSON.stringify({ error: "Unauthorized" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { status: "ok" } }),
      });
    });

    await page.goto("/");
    await seedAuthenticatedState(page);
    await page.reload();
    await waitForAppShellReady(page);

    // A rotation happened, and the replay path was never taken.
    expect(refresh.callCount()).toBeGreaterThan(0);
    expect(refresh.familyRevoked()).toBe(false);

    // The consumed token must be gone from storage — keeping it is precisely
    // what trips token_reuse on the next refresh.
    const stored = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.refreshToken,
    );
    expect(refresh.consumedTokens()).toContain(MOCK_REFRESH_TOKEN);
    expect(stored).not.toBe(MOCK_REFRESH_TOKEN);
    expect(stored).toBe(refresh.liveRefreshToken());
  });

  test("node rejects a replayed refresh token with token_reuse and revokes the family", async ({
    page,
  }) => {
    await stubTauriIPC(page);
    await mockCoreAPIs(page);
    const refresh = await mockSingleUseRefresh(page);
    await page.goto("/");

    // Two holders of the same refresh token, exactly as the old URL-hash handoff
    // produced: the second one to refresh presents an already-consumed token.
    const replay = await page.evaluate(async (token) => {
      const post = async (refresh_token: string) => {
        const res = await fetch("http://localhost:2528/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: "stale", refresh_token }),
        });
        return {
          status: res.status,
          authError: res.headers.get("x-auth-error"),
          body: await res.json().catch(() => null),
        };
      };
      return { first: await post(token), second: await post(token) };
    }, MOCK_REFRESH_TOKEN);

    // First holder rotates fine and gets a brand-new pair.
    expect(replay.first.status).toBe(200);
    expect(replay.first.body.data.refresh_token).not.toBe(MOCK_REFRESH_TOKEN);

    // Second holder replays the consumed token → theft → family revoked.
    expect(replay.second.status).toBe(401);
    expect(replay.second.authError).toBe("token_reuse");
    expect(refresh.familyRevoked()).toBe(true);
  });
});

// ─── 401 / auth error redirect ───────────────────────────────────────────────

test.describe("401 redirect to login", () => {
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

test.describe("Node disconnected state", () => {
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
      route.fulfill({ status: 200, contentType: "application/json", body: listApplicationsWireBody([]) }),
    );
    await page.route(API_ROUTES.listContexts, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: listContextsWireBody([]) }),
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
