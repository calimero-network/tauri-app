import { test, expect } from "./fixtures/test";
import {
  MOCK_REGISTRY_APPS,
  MOCK_INSTALLED_APPS,
  API_ROUTES,
  listApplicationsWireBody,
} from "./fixtures/mock-data";
import {
  setupAuthenticatedPage,
  mockRegistryAPIs,
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
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();

    const chatCard = page.locator("[data-testid='app-card']", { hasText: "Only Peers Chat" });
    await expect(chatCard).toBeVisible();
    // A pill, not a disabled button: the card is one click target now, and a
    // disabled button inside it could not be nested legally anyway.
    await expect(chatCard.locator(".app-card-installed")).toHaveText(/Installed/);
  });

  test("cards render the bundle icon, not a generic glyph", async ({ page }) => {
    // The listing drew one lucide box for every app while the registry, reading
    // the SAME endpoint, drew real launcher icons — the mapper was dropping
    // `metadata.icon`. Assert the <img> is really there, because the component
    // falls back to a letter tile the moment it fails to decode.
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    const chatCard = page.locator("[data-testid='app-card']", { hasText: "Only Peers Chat" });
    const icon = chatCard.locator("img.app-icon-img");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveJSProperty("naturalWidth", 1);
  });

  test("a bundle with no icon gets the lettered fallback, not a broken image", async ({ page }) => {
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    const demo = page.locator("[data-testid='app-card']", { hasText: "Blockchain Demo" });
    await expect(demo.getByTestId("app-icon-fallback")).toHaveText("B");
    await expect(demo.locator("img.app-icon-img")).toHaveCount(0);
  });

  test("opening a card replaces the listing with the application page", async ({ page }) => {
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");

    await page.locator("[data-testid='app-card']", { hasText: "Only Peers Chat" }).click();
    const detail = page.getByTestId("app-detail-page");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("only-peers-chat");
    await expect(detail.getByTestId("detail-install")).toBeVisible();
    await expect(detail.getByTestId("version-picker")).toBeVisible();
    // The grid is REPLACED, not covered — this is a page, not a modal.
    await expect(page.locator("[data-testid='app-card']")).toHaveCount(0);

    await detail.locator(".app-detail-back").click();
    await expect(page.locator("[data-testid='app-card']").first()).toBeVisible();
  });

  test("the version picker is our own control, and works by mouse and keyboard", async ({ page }) => {
    // ⚠️ NOT A NATIVE <select>: in a Tauri webview that renders the OS's own
    // menu, with its own font, metrics and highlight, inside a window that is
    // otherwise entirely our design system.
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    await page.locator("[data-testid='app-card']", { hasText: "Only Peers Chat" }).click();

    const trigger = page.getByTestId("version-picker");
    await expect(trigger).toBeVisible();
    // A button with listbox semantics — not a <select> element.
    await expect(trigger).toHaveJSProperty("tagName", "BUTTON");
    await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    await expect(page.locator("select")).toHaveCount(0);

    // Closed by default, opens on click, and the list is a real listbox.
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await trigger.click();
    await expect(page.getByRole("listbox")).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");

    // Escape dismisses without changing the value.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(trigger).toContainText("0.3.0");

    // And it is reachable from the keyboard alone.
    await trigger.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(trigger).toContainText("0.3.0");
  });

  test("the application page carries the structured metadata the card list never showed", async ({ page }) => {
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");
    await page.locator("[data-testid='app-card']", { hasText: "Only Peers Chat" }).click();

    const detail = page.getByTestId("app-detail-page");
    await expect(detail).toContainText("dev1.testnet");
    await expect(detail).toContainText("42");
    await expect(detail).toContainText("Communication");
    // Two DIFFERENT claims, so two separately labelled marks.
    await expect(detail.getByLabel("Verified package")).toBeVisible();
    await expect(detail.getByLabel("Verified author")).toBeVisible();
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

  test("renders installed apps as cards, with version info", async ({ page }) => {
    for (const app of MOCK_INSTALLED_APPS) {
      const meta = JSON.parse(atob(app.metadata));
      const displayName = meta.name || app.name;
      const card = page.locator("[data-testid='installed-app-card']", { hasText: displayName });
      await expect(card).toBeVisible();
      await expect(card).toContainText(`v${app.version}`);
    }
  });

  test("cards render the bundle icon instead of a row of text", async ({ page }) => {
    // These bundles have carried a launcher icon in their metadata all along —
    // handleCreateLauncher already passes the same field to
    // create_desktop_shortcut — and the table never showed it.
    const card = page.locator("[data-testid='installed-app-card']", { hasText: "Only Peers Chat" });
    const icon = card.locator("img.app-icon-img");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveJSProperty("naturalWidth", 1);
  });

  test("an app with no icon falls back to a letter tile", async ({ page }) => {
    const card = page.locator("[data-testid='installed-app-card']", { hasText: "Blockchain Demo" });
    await expect(card.getByTestId("app-icon-fallback")).toHaveText("B");
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

    // Matched by class, not text: the button carries only an icon, so a
    // text-based locator never found it and this test never clicked anything.
    const refreshBtn = page.locator(".installed-refresh-btn");
    await expect(refreshBtn).toBeVisible();
    const requestPromise = page.waitForRequest(API_ROUTES.listApplications);
    await refreshBtn.click();
    await requestPromise;
    expect(listCallCount).toBeGreaterThanOrEqual(1);
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

test.describe("Installed Applications – row variants", () => {
  test("app without frontend URL shows Uninstall but not Open or Shortcut", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Applications");
    await expect(
      page.locator(".installed-apps-header h1"),
    ).toBeVisible();

    const demoRow = page.locator("[data-testid='installed-app-card']", { hasText: "Blockchain Demo" });
    // No frontend URL → no Open button on the card
    await expect(demoRow.getByTestId("open-app")).toHaveCount(0);
    await expect(demoRow).toContainText("No web frontend");
    // Uninstall lives inside the More dropdown
    await demoRow.locator('.installed-app-more-btn').click();
    await expect(page.locator('.app-actions-dropdown .dropdown-item', { hasText: "Uninstall" })).toBeVisible();
  });
});

// ─── Open & Shortcut buttons ─────────────────────────────────────────────────

test.describe("Installed Applications – actions", () => {
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
    const chatRow = page.locator("[data-testid='installed-app-card']", { hasText: "Only Peers Chat" });
    await expect(chatRow.getByTestId("open-app")).toBeVisible();
  });

  test("Uninstall is in dropdown for all installed apps", async ({
    page,
  }) => {
    for (const app of MOCK_INSTALLED_APPS) {
      const meta = JSON.parse(atob(app.metadata));
      const displayName = meta.name || app.name;
      const row = page.locator("[data-testid='installed-app-card']", { hasText: displayName });
      await row.locator('.installed-app-more-btn').click();
      await expect(
        page.locator('.app-actions-dropdown .dropdown-item', { hasText: "Uninstall" }),
      ).toBeVisible();
      // close dropdown before next iteration
      await page.locator('.installed-apps-header').click();
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
      page.locator(".installed-apps-header h1"),
    ).toBeVisible();

    await navigateVia(page, "Marketplace");
    await expect(
      page.locator("h1", { hasText: "Application Marketplace" }),
    ).toBeVisible();
  });
});
