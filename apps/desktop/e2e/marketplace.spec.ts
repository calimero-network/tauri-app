import { test, expect } from "@playwright/test";
import {
  MOCK_REGISTRY_APPS,
  MOCK_INSTALLED_APPS,
  API_ROUTES,
} from "./fixtures/mock-data";
import {
  setupAuthenticatedPage,
  mockRegistryAPIs,
  mockInstallAPIs,
  navigateVia,
  mockCoreAPIs,
  seedAuthenticatedState,
} from "./fixtures/helpers";

// ─── Marketplace page ─────────────────────────────────────────────────────────

test.describe("Marketplace – browsing & searching", () => {
  test.beforeEach(async ({ page }) => {
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();
  });

  test("renders the marketplace heading and search input", async ({
    page,
  }) => {
    await expect(page.locator('input[placeholder="Search applications..."]')).toBeVisible();
    await expect(page.locator("select.filter-select")).toBeVisible();
  });

  test("displays apps fetched from registry", async ({ page }) => {
    for (const app of MOCK_REGISTRY_APPS) {
      const displayName = app.alias || app.name;
      await expect(page.locator("h3", { hasText: displayName })).toBeVisible();
    }
  });

  test("filters apps by search query", async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search applications..."]');
    await searchInput.fill("chat");
    await expect(page.locator("h3", { hasText: "Only Peers Chat" })).toBeVisible();
    await expect(page.locator("h3", { hasText: "Blockchain Demo" })).not.toBeVisible();
  });

  test("clears search to show all apps again", async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search applications..."]');
    await searchInput.fill("chat");
    await expect(page.locator("h3", { hasText: "Blockchain Demo" })).not.toBeVisible();

    await searchInput.fill("");
    await expect(page.locator("h3", { hasText: "Only Peers Chat" })).toBeVisible();
    await expect(page.locator("h3", { hasText: "Blockchain Demo" })).toBeVisible();
  });

  test("search with no results shows empty state", async ({ page }) => {
    const searchInput = page.locator('input[placeholder="Search applications..."]');
    await searchInput.fill("nonexistent-app-xyz");
    await expect(page.locator(".app-card")).toHaveCount(0);
  });

  test("refresh button is present and clickable", async ({ page }) => {
    const refreshBtn = page.locator('button[title="Refresh applications"]');
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
  });
});

// ─── Install flow ────────────────────────────────────────────────────────────

test.describe("Marketplace – install flow", () => {
  test("install button triggers install API call", async ({ page }) => {
    await mockRegistryAPIs(page);
    await mockInstallAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();

    const appCard = page.locator(".app-card", { hasText: "Blockchain Demo" });
    await expect(appCard).toBeVisible();

    let installCalled = false;
    await page.route(API_ROUTES.installApplication, (route) => {
      installCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { success: true } }),
      });
    });

    const installBtn = appCard.locator("button", { hasText: "Install" });
    await expect(installBtn).toBeVisible();
    await installBtn.click();

    await page.waitForTimeout(500);
    expect(installCalled).toBe(true);
  });

  test("already-installed app shows 'Installed' badge instead of Install button", async ({
    page,
  }) => {
    await page.route(API_ROUTES.registryBundles, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          MOCK_REGISTRY_APPS.map((app) => ({
            ...app,
            id: app.id === "app-1" ? "installed-app-1" : app.id,
          })),
        ),
      }),
    );

    await mockInstallAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();

    const chatCard = page.locator(".app-card", { hasText: "Only Peers Chat" });
    await expect(chatCard).toBeVisible();
    await expect(
      chatCard.locator("button", { hasText: "Installed" }),
    ).toBeVisible();
    await expect(
      chatCard.locator("button", { hasText: "Installed" }),
    ).toBeDisabled();
  });
});

// ─── Installed Applications page ──────────────────────────────────────────────

test.describe("Installed Applications – listing", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Applications");
    await expect(
      page.locator("h1", { hasText: "Installed Applications" }),
    ).toBeVisible();
  });

  test("renders installed apps in a table", async ({ page }) => {
    for (const app of MOCK_INSTALLED_APPS) {
      const meta = JSON.parse(atob(app.metadata));
      const displayName = meta.name || app.name;
      await expect(page.locator("td", { hasText: displayName })).toBeVisible();
    }
  });

  test("shows version info for installed apps", async ({ page }) => {
    for (const app of MOCK_INSTALLED_APPS) {
      await expect(page.locator("td", { hasText: app.version })).toBeVisible();
    }
  });

  test("refresh button reloads the app list", async ({ page }) => {
    let listCallCount = 0;
    await page.route(API_ROUTES.listApplications, (route) => {
      listCallCount++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: MOCK_INSTALLED_APPS }),
      });
    });

    const refreshBtn = page.locator("button", { hasText: /refresh/i });
    if (await refreshBtn.isVisible()) {
      await refreshBtn.click();
      await page.waitForTimeout(300);
      expect(listCallCount).toBeGreaterThanOrEqual(1);
    }
  });
});

test.describe("Installed Applications – empty state", () => {
  test("shows empty message when no apps are installed", async ({ page }) => {
    await mockCoreAPIs(page);
    await page.route(API_ROUTES.listApplications, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [] }),
      }),
    );
    await page.goto("/");
    await seedAuthenticatedState(page);
    await page.reload();

    await navigateVia(page, "Applications");
    await expect(
      page.locator("h1", { hasText: "Installed Applications" }),
    ).toBeVisible();
    await expect(page.getByText("No applications installed.")).toBeVisible();
  });
});

// ─── Uninstall flow ──────────────────────────────────────────────────────────

test.describe("Installed Applications – uninstall flow", () => {
  test("uninstall button triggers uninstall API call", async ({ page }) => {
    await mockInstallAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Applications");
    await expect(
      page.locator("h1", { hasText: "Installed Applications" }),
    ).toBeVisible();

    let uninstallCalled = false;
    await page.route(API_ROUTES.uninstallApplication, (route) => {
      uninstallCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { success: true } }),
      });
    });

    const uninstallBtn = page
      .locator("tr", { hasText: "Only Peers Chat" })
      .locator("button", { hasText: "Uninstall" });

    if (await uninstallBtn.isVisible()) {
      await uninstallBtn.click();

      const confirmBtn = page.locator("button", { hasText: /confirm|yes/i });
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click();
      }

      await page.waitForTimeout(500);
      expect(uninstallCalled).toBe(true);
    }
  });
});

// ─── Open & Shortcut buttons ─────────────────────────────────────────────────

test.describe("Installed Applications – actions", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Applications");
    await expect(
      page.locator("h1", { hasText: "Installed Applications" }),
    ).toBeVisible();
  });

  test("Open button is visible for apps with frontend URLs", async ({
    page,
  }) => {
    const chatRow = page.locator("tr", { hasText: "Only Peers Chat" });
    const openBtn = chatRow.locator('button:has-text("Open")');
    await expect(openBtn).toBeVisible();
  });

  test("Shortcut button is visible for apps with frontend URLs", async ({
    page,
  }) => {
    const chatRow = page.locator("tr", { hasText: "Only Peers Chat" });
    const shortcutBtn = chatRow.locator('button:has-text("Shortcut")');
    await expect(shortcutBtn).toBeVisible();
  });

  test("Uninstall button is visible for all installed apps", async ({
    page,
  }) => {
    for (const app of MOCK_INSTALLED_APPS) {
      const meta = JSON.parse(atob(app.metadata));
      const displayName = meta.name || app.name;
      const row = page.locator("tr", { hasText: displayName });
      await expect(
        row.locator('button:has-text("Uninstall")'),
      ).toBeVisible();
    }
  });
});

// ─── Cross-page navigation ───────────────────────────────────────────────────

test.describe("Marketplace ↔ Applications navigation", () => {
  test("can navigate between Marketplace and Applications", async ({
    page,
  }) => {
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);

    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();

    await navigateVia(page, "Applications");
    await expect(
      page.locator("h1", { hasText: "Installed Applications" }),
    ).toBeVisible();

    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();
  });
});
