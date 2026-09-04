import { test, expect } from "./fixtures/test";
import {
  setupDeveloperPage,
  setupAuthenticatedPage,
  navigateVia,
} from "./fixtures/helpers";

// ─── Namespaces page – requires developer mode ──────────────────────────────

test.describe("Namespaces – requires developer mode", () => {
  test("Namespaces link is not in sidebar without developer mode", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTitle("Namespaces")).not.toBeVisible();
  });

  test("Namespaces link appears in sidebar with developer mode", async ({
    page,
  }) => {
    await setupDeveloperPage(page);

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTitle("Namespaces")).toBeVisible();
  });
});

// ─── Namespaces page – rendering ────────────────────────────────────────────

test.describe("Namespaces – page rendering", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Namespaces");
  });

  test("renders the shell page title and the Namespaces heading", async ({
    page,
  }) => {
    await expect(page.getByTestId("shell-page-title")).toHaveText(
      "Namespaces",
    );
    await expect(page.locator(".ns-page-top h1")).toHaveText("Namespaces");
  });

  test("shows empty state or error, with no namespace cards, when none are available", async ({
    page,
  }) => {
    // Without a running node, the page shows either the empty state or an error.
    // Wait for loading to finish by checking for either outcome via CSS class.
    const loaded = page.locator(".empty-state, .error-message").first();
    await expect(loaded).toBeVisible();

    const cards = page.locator(".ns-card");
    await expect(cards).toHaveCount(0);
  });
});
