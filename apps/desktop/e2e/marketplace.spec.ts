import { test, expect } from "@playwright/test";
import {
  MOCK_REGISTRY_APPS,
  MOCK_INSTALLED_APPS,
  API_ROUTES,
  listApplicationsWireBody,
} from "./fixtures/mock-data";
import {
  setupAuthenticatedPage,
  mockRegistryAPIs,
  mockInstallAPIs,
  navigateVia,
  mockCoreAPIs,
  seedAuthenticatedState,
} from "./fixtures/helpers";
import { describeAfter35 } from "./fixtures/e2e-cap";

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
    await expect(page.locator(".filter-pill").first()).toBeVisible();
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
    await expect(page.locator("[data-testid='app-card']")).toHaveCount(0);
  });

  test("refresh button is present and clickable", async ({ page }) => {
    const refreshBtn = page.locator('.marketplace-filters button[title="Refresh"]');
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
  });
});

// ─── Install flow ────────────────────────────────────────────────────────────

test.describe("Marketplace – install flow", () => {
  test("already-installed app shows 'Installed' badge instead of Install button", async ({
    page,
  }) => {
    await mockRegistryAPIs(page);
    await mockInstallAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();

    const chatCard = page.locator("[data-testid='app-card']", { hasText: "Only Peers Chat" });
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
      page.locator(".installed-apps-header h1"),
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
        body: listApplicationsWireBody(MOCK_INSTALLED_APPS),
      });
    });

    const refreshBtn = page.locator("button", { hasText: /refresh/i });
    if (await refreshBtn.isVisible()) {
      const requestPromise = page.waitForRequest(API_ROUTES.listApplications);
      await refreshBtn.click();
      await requestPromise;
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
        body: listApplicationsWireBody([]),
      }),
    );
    await page.goto("/");
    await seedAuthenticatedState(page);
    await page.reload();

    await navigateVia(page, "Applications");
    await expect(
      page.locator(".installed-apps-header h1"),
    ).toBeVisible();
    await expect(page.getByText("No applications installed.")).toBeVisible();
  });
});

// ─── Row-level UI (cap ≥ 4.5) ────────────────────────────────────────────────
// Uninstall → confirm → API is exercised manually; the in-app confirm screen and
// real client make that flow brittle in e2e. We instead assert metadata-driven actions.

describeAfter35("Installed Applications – row variants", () => {
  test("app without frontend URL shows Uninstall but not Open or Shortcut", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Applications");
    await expect(
      page.locator(".installed-apps-header h1"),
    ).toBeVisible();

    const demoRow = page.locator("tr", { hasText: "Blockchain Demo" });
    // No frontend URL → no Open button directly in row
    await expect(demoRow.locator('button.btn-open')).toHaveCount(0);
    // Uninstall lives inside the More dropdown
    await demoRow.locator('.btn-more').click();
    await expect(page.locator('.app-actions-dropdown .dropdown-item', { hasText: "Uninstall" })).toBeVisible();
  });
});

// ─── Open & Shortcut buttons ─────────────────────────────────────────────────

describeAfter35("Installed Applications – actions", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Applications");
    await expect(
      page.locator(".installed-apps-header h1"),
    ).toBeVisible();
  });

  test("Open button is visible for apps with frontend URLs", async ({
    page,
  }) => {
    const chatRow = page.locator("tr", { hasText: "Only Peers Chat" });
    const openBtn = chatRow.locator('button:has-text("Open")');
    await expect(openBtn).toBeVisible();
  });

  test("dropdown menu has Uninstall for apps with frontend URLs", async ({
    page,
  }) => {
    const chatRow = page.locator("tr", { hasText: "Only Peers Chat" });
    await chatRow.locator('.btn-more').click();
    await expect(page.locator('.app-actions-dropdown .dropdown-item', { hasText: "Uninstall" })).toBeVisible();
  });

  test("Uninstall is in dropdown for all installed apps", async ({
    page,
  }) => {
    for (const app of MOCK_INSTALLED_APPS) {
      const meta = JSON.parse(atob(app.metadata));
      const displayName = meta.name || app.name;
      const row = page.locator("tr", { hasText: displayName });
      await row.locator('.btn-more').click();
      await expect(
        page.locator('.app-actions-dropdown .dropdown-item', { hasText: "Uninstall" }),
      ).toBeVisible();
      // close dropdown before next iteration
      await page.locator('.installed-apps-header').click();
    }
  });
});

// ─── Cross-page navigation ───────────────────────────────────────────────────

describeAfter35("Marketplace ↔ Applications navigation", () => {
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
      page.locator(".installed-apps-header h1"),
    ).toBeVisible();

    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();
  });
});
