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

// ─── Namespaces page – grouped by application ───────────────────────────────

/**
 * The page used to render every namespace on the node as one flat grid of
 * hashes, with no way to tell which application a workspace belonged to
 * without opening it. Namespaces are app-bound (`targetApplicationId`), so the
 * listing is grouped: applications first, then that application's namespaces.
 *
 * These specs pin the structure AND the card fields — title, package, version,
 * icon — because a card that renders the application id four times looks fine
 * to a count-only assertion.
 */

/** Two namespaces on `installed-app-1`, one on `installed-app-2`. */
const GROUPED_NAMESPACES = [
  {
    namespaceId: "a".repeat(64),
    targetApplicationId: "installed-app-1",
    bytecodeId: "bytecode-1",
    createdAt: 0,
    name: "chat workspace",
    memberCount: 2,
    contextCount: 1,
    subgroupCount: 0,
  },
  {
    namespaceId: "b".repeat(64),
    targetApplicationId: "installed-app-1",
    bytecodeId: "bytecode-1",
    createdAt: 0,
    name: "second chat workspace",
    memberCount: 1,
    contextCount: 0,
    subgroupCount: 0,
  },
  {
    namespaceId: "c".repeat(64),
    targetApplicationId: "installed-app-2",
    bytecodeId: "bytecode-2",
    createdAt: 0,
    name: "demo workspace",
    memberCount: 1,
    contextCount: 0,
    subgroupCount: 0,
  },
];

async function setupGroupedNamespaces(page: import("@playwright/test").Page) {
  await setupDeveloperPage(page);
  await page.route("**/admin-api/namespaces*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: GROUPED_NAMESPACES }),
    }),
  );
  await navigateVia(page, "Namespaces");
}

test.describe("Namespaces – grouped by application", () => {
  test.beforeEach(async ({ page }) => {
    await setupGroupedNamespaces(page);
  });

  test("lists applications, not namespaces, at the top level", async ({
    page,
  }) => {
    await expect(page.getByTestId("ns-app-card")).toHaveCount(2);
    // No namespace card is on the root screen — that is the whole point.
    await expect(page.locator(".ns-card")).toHaveCount(0);
  });

  test("an application card carries title, package, version and icon", async ({
    page,
  }) => {
    const card = page.locator('.ns-app-card[data-application-id="installed-app-1"]');

    await expect(card.locator(".ns-app-card-title")).toHaveText("Only Peers Chat");
    await expect(card.locator(".ns-app-card-package")).toHaveText("only-peers-chat");
    await expect(card.locator(".ns-app-version")).toHaveText("v0.3.0");
    // The bundle carries an icon, so the deterministic letter fallback must NOT
    // be what renders.
    await expect(card.locator("img.app-icon-img")).toBeVisible();
    await expect(card.getByTestId("app-icon-fallback")).toHaveCount(0);
    await expect(card.locator(".ns-app-card-count")).toHaveText("2 namespaces");
  });

  test("a bundle with no icon falls back to the letter tile, not a broken image", async ({
    page,
  }) => {
    const card = page.locator('.ns-app-card[data-application-id="installed-app-2"]');

    await expect(card.locator(".ns-app-card-title")).toHaveText("Blockchain Demo");
    await expect(card.getByTestId("app-icon-fallback")).toBeVisible();
    await expect(card.locator(".ns-app-card-count")).toHaveText("1 namespace");
  });

  test("opening an application shows only that application's namespaces", async ({
    page,
  }) => {
    await page.locator('.ns-app-card[data-application-id="installed-app-1"]').click();

    await expect(page.locator(".ns-page-top h1")).toHaveText("Only Peers Chat");
    await expect(page.locator(".ns-card")).toHaveCount(2);
    await expect(page.getByText("chat workspace", { exact: true })).toBeVisible();
    await expect(page.getByText("second chat workspace", { exact: true })).toBeVisible();
    // The other application's namespace is not on this screen.
    await expect(page.getByText("demo workspace", { exact: true })).toHaveCount(0);

    await page.locator(".ns-back").click();
    await expect(page.getByTestId("ns-app-card")).toHaveCount(2);
  });

  test("creating from an application page preselects that application", async ({
    page,
  }) => {
    await page.locator('.ns-app-card[data-application-id="installed-app-2"]').click();
    await page.getByRole("button", { name: "Create Namespace" }).click();

    const modal = page.getByRole("dialog", { name: "Create Namespace" });
    await expect(modal.locator(".ns-app-select-name")).toHaveText("Blockchain Demo");
  });
});
