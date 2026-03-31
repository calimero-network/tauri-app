import { test, expect } from "@playwright/test";
import {
  setupConnectedPage,
  setupDisconnectedPage,
  setupEmbeddedNodePage,
  waitForNodeStatus,
  mockHealthy,
  mockUnhealthy,
  mockCoreAPIs,
  seedSettings,
  seedAuthTokens,
  clearAllStorage,
} from "./fixtures/helpers";
import {
  AUTHENTICATED_SETTINGS,
  EMBEDDED_NODE_SETTINGS,
  DISCONNECTED_SETTINGS,
  DEFAULT_NODE_URL,
} from "./fixtures/mock-data";

/**
 * Node lifecycle tests.
 *
 * These tests verify the application's behaviour when the node is in various
 * states: healthy / connected, unreachable / disconnected, and when the user
 * has configured an embedded node. Because actual node management goes through
 * Tauri `invoke` commands (merod binary), we focus on UI rendering and the
 * app's reaction to mocked health-check responses rather than backend
 * side-effects.
 */

// ─── Connected state ────────────────────────────────────────────────────────

test.describe("Node lifecycle – connected", () => {
  test.beforeEach(async ({ page }) => {
    await setupConnectedPage(page);
  });

  test("shows the Connected status indicator", async ({ page }) => {
    await waitForNodeStatus(page, "connected");

    const indicator = page.locator(".node-status-indicator.connected");
    await expect(indicator).toBeVisible();
    await expect(indicator.locator(".node-status-label")).toHaveText(
      "Connected",
    );
  });

  test("connected indicator has a green dot", async ({ page }) => {
    await waitForNodeStatus(page, "connected");

    const dot = page.locator(
      ".node-status-indicator.connected .node-status-dot",
    );
    await expect(dot).toBeVisible();
  });

  test("does not show 'Restart Node' action when healthy", async ({
    page,
  }) => {
    await waitForNodeStatus(page, "connected");

    await expect(page.locator(".node-status-action")).not.toBeVisible();
  });

  test("sidebar navigation is accessible when connected", async ({ page }) => {
    await waitForNodeStatus(page, "connected");

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTitle("Home")).toBeVisible();
  });
});

// ─── Disconnected state ─────────────────────────────────────────────────────

test.describe("Node lifecycle – disconnected", () => {
  test.beforeEach(async ({ page }) => {
    await setupDisconnectedPage(page);
  });

  test("shows the Disconnected status indicator", async ({ page }) => {
    await waitForNodeStatus(page, "disconnected");

    const indicator = page.locator(".node-status-indicator.disconnected");
    await expect(indicator).toBeVisible();
    await expect(indicator.locator(".node-status-label")).toHaveText(
      "Disconnected",
    );
  });

  test("disconnected indicator has a dot", async ({ page }) => {
    await waitForNodeStatus(page, "disconnected");

    const dot = page.locator(
      ".node-status-indicator.disconnected .node-status-dot",
    );
    await expect(dot).toBeVisible();
  });
});

// ─── Transition from disconnected → connected ───────────────────────────────

test.describe("Node lifecycle – reconnection", () => {
  test("transitions to Connected when health endpoint recovers", async ({
    page,
  }) => {
    await setupDisconnectedPage(page);
    await waitForNodeStatus(page, "disconnected");

    await page.unroute("**/auth/health");
    await page.unroute("**/admin-api/health");
    await mockHealthy(page);

    await waitForNodeStatus(page, "connected", 15_000);

    const indicator = page.locator(".node-status-indicator.connected");
    await expect(indicator).toBeVisible();
  });
});

// ─── Transition from connected → disconnected ───────────────────────────────

test.describe("Node lifecycle – connection loss", () => {
  test("transitions to Disconnected when health endpoint starts failing", async ({
    page,
  }) => {
    await setupConnectedPage(page);
    await waitForNodeStatus(page, "connected");

    await page.unroute("**/auth/health");
    await page.unroute("**/admin-api/health");
    await mockUnhealthy(page);

    await waitForNodeStatus(page, "disconnected", 15_000);

    const indicator = page.locator(".node-status-indicator.disconnected");
    await expect(indicator).toBeVisible();
  });
});

// ─── Embedded node settings ─────────────────────────────────────────────────

test.describe("Node lifecycle – embedded node configuration", () => {
  test.beforeEach(async ({ page }) => {
    await setupEmbeddedNodePage(page);
  });

  test("renders with connected status when embedded node is healthy", async ({
    page,
  }) => {
    await waitForNodeStatus(page, "connected");

    const indicator = page.locator(".node-status-indicator.connected");
    await expect(indicator).toBeVisible();
  });

  test("sidebar is accessible with embedded node settings", async ({
    page,
  }) => {
    await waitForNodeStatus(page, "connected");

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();
  });
});

// ─── Fresh state / no settings ──────────────────────────────────────────────

test.describe("Node lifecycle – fresh state", () => {
  test("app without completed onboarding shows onboarding flow", async ({
    page,
  }) => {
    await mockCoreAPIs(page);
    await page.goto("/");
    await clearAllStorage(page);
    await page.reload();

    const onboardingPage = page.locator(".onboarding-page");
    await onboardingPage.waitFor({ state: "visible", timeout: 10_000 });

    await expect(
      page.getByRole("heading", { name: "Welcome to Calimero" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue" }),
    ).toBeVisible();
  });
});

// ─── Settings persistence ───────────────────────────────────────────────────

test.describe("Node lifecycle – settings persistence", () => {
  test("nodeUrl is persisted in localStorage", async ({ page }) => {
    await setupConnectedPage(page);

    const settings = await page.evaluate(() => {
      const raw = localStorage.getItem("calimero-desktop-settings");
      return raw ? JSON.parse(raw) : null;
    });

    expect(settings).not.toBeNull();
    expect(settings.nodeUrl).toBe(DEFAULT_NODE_URL);
  });

  test("embedded node settings are persisted correctly", async ({ page }) => {
    await setupEmbeddedNodePage(page);

    const settings = await page.evaluate(() => {
      const raw = localStorage.getItem("calimero-desktop-settings");
      return raw ? JSON.parse(raw) : null;
    });

    expect(settings).not.toBeNull();
    expect(settings.useEmbeddedNode).toBe(true);
    expect(settings.embeddedNodeName).toBe("test-node");
    expect(settings.embeddedNodePort).toBe(2528);
  });

  test("clearing storage removes all settings", async ({ page }) => {
    await setupConnectedPage(page);
    await clearAllStorage(page);

    const settings = await page.evaluate(() =>
      localStorage.getItem("calimero-desktop-settings"),
    );
    expect(settings).toBeNull();
  });
});
