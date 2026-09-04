import type { Locator, Page } from "@playwright/test";
import {
  STORAGE_KEYS,
  AUTHENTICATED_SETTINGS,
  DEVELOPER_SETTINGS,
  DEFAULT_SETTINGS,
  EMBEDDED_NODE_SETTINGS,
  MOCK_ACCESS_TOKEN,
  MOCK_REFRESH_TOKEN,
  MOCK_TOKEN_EXPIRES_AT,
  MOCK_HEALTH_OK,
  MOCK_HEALTH_UNREACHABLE,
  MOCK_PROVIDERS_RESPONSE,
  MOCK_INSTALLED_APPS,
  MOCK_REGISTRY_V2_BUNDLES,
  API_ROUTES,
  rotatedTokenPair,
  listApplicationsWireBody,
  listContextsWireBody,
  type AppSettings,
  type MockInstalledAppRow,
} from "./mock-data";

export type MockCoreAPIsOptions = {
  /** Defaults to `MOCK_INSTALLED_APPS` (non-empty app dropdown for create-context flows). */
  installedApps?: MockInstalledAppRow[];
};

// ─── Tauri IPC stub ──────────────────────────────────────────────────────────

/**
 * Stub the Tauri **v2** invoke bridge (`window.__TAURI_INTERNALS__`) with a
 * per-command response map, and record every call on `window.__invokeCalls` so a
 * test can assert what the UI asked the backend to do.
 *
 * Use this when a test needs a command to actually *succeed*. Must be called
 * before the page navigates.
 *
 * A command with no entry in `responses` resolves to `null`, matching the
 * permissive v1 stub. **Stub every command whose result the page treats as an
 * array** — components hand these straight to `useState` and then call
 * `.reduce`/`.map` on them, so a `null` throws during render and the error
 * boundary replaces the page you were trying to test.
 */
export async function stubTauriInvoke(
  page: Page,
  responses: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript((responses: Record<string, unknown>) => {
    (window as any).__invokeCalls = [];
    (window as any).__TAURI_INTERNALS__ = {
      // invoke() calls this to register callbacks; an identity fn is enough
      // because we never round-trip through the real IPC channel.
      transformCallback: (cb: unknown) => cb,
      invoke: (cmd: string, args: unknown) => {
        (window as any).__invokeCalls.push({ cmd, args });
        const value = Object.prototype.hasOwnProperty.call(responses, cmd)
          ? responses[cmd]
          : null;
        // Errors are expressed as { __error: "..." } so a plain string payload
        // stays a successful result.
        if (value && typeof value === "object" && "__error" in (value as object)) {
          return Promise.reject(new Error(String((value as any).__error)));
        }
        return Promise.resolve(value);
      },
    };
  }, responses);
}

/** Commands invoked so far, oldest first. */
export async function getInvokeCalls(
  page: Page,
): Promise<Array<{ cmd: string; args: any }>> {
  return await page.evaluate(() => (window as any).__invokeCalls ?? []);
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
        body: listContextsWireBody(),
      });
    }
    return route.continue();
  });
}

// ─── Single-use refresh tokens (calimero-network/core#3083) ──────────────────

/**
 * The node signals *why* a 401 happened via `x-auth-error`, and clients key off
 * it: mero-js only auto-refreshes on `token_expired` (web-client.js), and
 * mero-js#67 treats `token_reuse` / `token_revoked` as terminal.
 *
 * The app is a different origin from the node (1420 → 2528), so the browser
 * hides that header from JS unless the node also sends
 * `Access-Control-Expose-Headers`. A mock that omits it silently disables every
 * refresh path — the client can't see the header, so it never refreshes.
 */
export const AUTH_ERROR_HEADERS = (reason: string): Record<string, string> => ({
  "x-auth-error": reason,
  "access-control-expose-headers": "x-auth-error",
});

export interface SingleUseRefreshMock {
  /** How many POST /auth/refresh calls the node received. */
  callCount(): number;
  /** True once a consumed refresh token was re-presented → family revoked. */
  familyRevoked(): boolean;
  /** The refresh token the node currently accepts. */
  liveRefreshToken(): string;
  /** Every refresh token the node has already consumed. */
  consumedTokens(): readonly string[];
}

/**
 * Model the node's single-use refresh-token rotation.
 *
 * Each POST /auth/refresh **consumes** the presented refresh token and returns a
 * brand-new pair. Re-presenting a consumed token is treated as theft: the node
 * revokes the whole token family and answers 401 `x-auth-error: token_reuse`,
 * after which nothing in that family works again.
 *
 * That is the real server contract, so a client that hangs on to a consumed
 * refresh token — or that hands the same one to a second holder, which is what
 * the desktop used to do by putting it in every app window's URL hash — now
 * fails loudly here instead of passing against a permissive mock.
 */
export async function mockSingleUseRefresh(
  page: Page,
): Promise<SingleUseRefreshMock> {
  let generation = 0;
  let live = MOCK_REFRESH_TOKEN;
  let revoked = false;
  let calls = 0;
  const consumed = new Set<string>();

  await page.route(API_ROUTES.refreshToken, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    calls += 1;

    let presented = "";
    try {
      const body = route.request().postDataJSON() as
        | { refresh_token?: string }
        | null;
      presented = body?.refresh_token ?? "";
    } catch {
      presented = "";
    }

    // Replay of a consumed token → theft. Revoke the family for good.
    if (consumed.has(presented)) {
      revoked = true;
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: AUTH_ERROR_HEADERS("token_reuse"),
        body: JSON.stringify({ error: "refresh token reuse detected" }),
      });
    }

    if (revoked || presented !== live) {
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: AUTH_ERROR_HEADERS("token_revoked"),
        body: JSON.stringify({ error: "invalid refresh token" }),
      });
    }

    consumed.add(presented);
    generation += 1;
    const next = rotatedTokenPair(generation);
    live = next.refresh_token;

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: next }),
    });
  });

  return {
    callCount: () => calls,
    familyRevoked: () => revoked,
    liveRefreshToken: () => live,
    consumedTokens: () => [...consumed],
  };
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
  label: "Home" | "Nodes" | "Namespaces" | "Applications" | "Marketplace",
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
  await mockCoreAPIs(page, options);
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
 * Setup for an authenticated page where the node is unreachable / disconnected.
 * The health endpoint returns 503, all other core routes are still mocked so the
 * app doesn't hang on unrelated requests. Routes registered later win, so
 * mockUnhealthy overrides the healthy default mockCoreAPIs just set up.
 */
export async function setupDisconnectedPage(page: Page): Promise<void> {
  await mockCoreAPIs(page, { installedApps: [] });
  await mockUnhealthy(page);

  await page.goto("/");
  await seedSettings(page, AUTHENTICATED_SETTINGS);
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
