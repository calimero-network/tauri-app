import { test, expect } from "./fixtures/test";
import { setupAuthenticatedPage, setupDeveloperPage } from "./fixtures/helpers";

test.describe("Sidebar navigation", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("sidebar renders with Home, Marketplace, and Applications links", async ({
    page,
  }) => {
    await expect(page.locator('button[title="Home"]')).toBeVisible();
    await expect(page.locator('button[title="Marketplace"]')).toBeVisible();
    await expect(page.locator('button[title="Applications"]')).toBeVisible();
    await expect(page.locator('button[title="Settings"]')).toBeVisible();
  });

  test("Home is active by default", async ({ page }) => {
    const homeBtn = page.locator('button[title="Home"]');
    await expect(homeBtn).toHaveClass(/active/);
  });

  test("clicking Marketplace navigates to marketplace page", async ({
    page,
  }) => {
    await page.click('button[title="Marketplace"]');
    await expect(page.getByTestId("shell-page-title")).toHaveText("Marketplace");
    await expect(page.locator('button[title="Marketplace"]')).toHaveClass(
      /active/
    );
  });

  test("clicking Applications navigates to installed apps page", async ({
    page,
  }) => {
    await page.click('button[title="Applications"]');
    await expect(page.getByTestId("shell-page-title")).toHaveText("Applications");
    await expect(page.locator('button[title="Applications"]')).toHaveClass(
      /active/
    );
  });

  test("clicking Home returns to home page", async ({ page }) => {
    await page.click('button[title="Marketplace"]');
    await expect(page.getByTestId("shell-page-title")).toHaveText("Marketplace");

    await page.click('button[title="Home"]');
    await expect(page.getByTestId("shell-page-title")).toHaveText("Home");
    await expect(page.locator('button[title="Home"]')).toHaveClass(/active/);
  });
});

test.describe("Sidebar navigation — developer mode", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
  });

  test("clicking Namespaces navigates to namespaces page", async ({ page }) => {
    await page.click('button[title="Namespaces"]');
    await expect(page.getByTestId("shell-page-title")).toHaveText("Namespaces");
    await expect(page.locator('button[title="Namespaces"]')).toHaveClass(
      /active/
    );
  });

  test("clicking Nodes navigates to nodes page", async ({ page }) => {
    await page.click('button[title="Nodes"]');
    await expect(page.getByTestId("shell-page-title")).toHaveText("Nodes");
    await expect(page.locator('button[title="Nodes"]')).toHaveClass(/active/);
  });
});

test.describe("Home page content", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("home page shows welcome message", async ({ page }) => {
    await expect(
      page.locator("text=Welcome to Calimero Desktop")
    ).toBeVisible();
  });

  test("home page shows Browse Marketplace quick action", async ({ page }) => {
    await expect(page.locator("text=Browse Marketplace")).toBeVisible();
  });

  test("home page shows Settings quick action", async ({ page }) => {
    await expect(page.getByText("Settings", { exact: false }).first()).toBeVisible();
  });

  test("home shows no-apps card when installed list is empty", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page, { installedApps: [] });
    await expect(
      page.getByRole("heading", { name: "No Applications Installed" }),
    ).toBeVisible();
  });
});
