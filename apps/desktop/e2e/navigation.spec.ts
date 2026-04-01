import { test, expect } from "@playwright/test";
import { describeAfter35 } from "./fixtures/e2e-cap";
import {
  setupAuthenticatedPage,
  setupDeveloperPage,
  seedSettings,
  seedAuthTokens,
  clearAllStorage,
} from "./fixtures/helpers";
import { DEFAULT_SETTINGS, AUTHENTICATED_SETTINGS, DEVELOPER_SETTINGS } from "./fixtures/mock-data";

describeAfter35("Sidebar navigation", () => {
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
    await expect(page.locator("h1")).toHaveText("Marketplace");
    await expect(page.locator('button[title="Marketplace"]')).toHaveClass(
      /active/
    );
  });

  test("clicking Applications navigates to installed apps page", async ({
    page,
  }) => {
    await page.click('button[title="Applications"]');
    await expect(page.locator("h1")).toHaveText("Applications");
    await expect(page.locator('button[title="Applications"]')).toHaveClass(
      /active/
    );
  });

  test("clicking Home returns to home page", async ({ page }) => {
    await page.click('button[title="Marketplace"]');
    await expect(page.locator("h1")).toHaveText("Marketplace");

    await page.click('button[title="Home"]');
    await expect(page.locator("h1")).toHaveText("Home");
    await expect(page.locator('button[title="Home"]')).toHaveClass(/active/);
  });

  test("Contexts link hidden when developer mode is off", async ({ page }) => {
    await expect(page.locator('button[title="Contexts"]')).not.toBeVisible();
  });

  test("Nodes link hidden when developer mode is off", async ({ page }) => {
    await expect(page.locator('button[title="Nodes"]')).not.toBeVisible();
  });
});

describeAfter35("Sidebar navigation — developer mode", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
  });

  test("Contexts link visible when developer mode is on", async ({ page }) => {
    await expect(page.locator('button[title="Contexts"]')).toBeVisible();
  });

  test("Nodes link visible when developer mode is on", async ({ page }) => {
    await expect(page.locator('button[title="Nodes"]')).toBeVisible();
  });

  test("clicking Contexts navigates to contexts page", async ({ page }) => {
    await page.click('button[title="Contexts"]');
    await expect(page.locator("h1")).toHaveText("Contexts");
    await expect(page.locator('button[title="Contexts"]')).toHaveClass(
      /active/
    );
  });

  test("clicking Nodes navigates to nodes page", async ({ page }) => {
    await page.click('button[title="Nodes"]');
    await expect(page.locator("h1")).toHaveText("Nodes");
    await expect(page.locator('button[title="Nodes"]')).toHaveClass(/active/);
  });

  test("full navigation cycle through all pages", async ({ page }) => {
    await page.click('button[title="Marketplace"]');
    await expect(page.locator("h1")).toHaveText("Marketplace");

    await page.click('button[title="Applications"]');
    await expect(page.locator("h1")).toHaveText("Applications");

    await page.click('button[title="Contexts"]');
    await expect(page.locator("h1")).toHaveText("Contexts");

    await page.click('button[title="Nodes"]');
    await expect(page.locator("h1")).toHaveText("Nodes");

    await page.click('button[title="Home"]');
    await expect(page.locator("h1")).toHaveText("Home");
  });
});

describeAfter35("Settings navigation", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("clicking Settings button opens settings page", async ({ page }) => {
    await page.click('button[title="Settings"]');
    await expect(page.locator("h1")).toHaveText("Settings");
  });

  test("settings page has Back button to return", async ({ page }) => {
    await page.click('button[title="Settings"]');
    await expect(page.locator("h1")).toHaveText("Settings");

    const backBtn = page.locator("button", { hasText: "Back" });
    await expect(backBtn).toBeVisible();
  });
});

describeAfter35("Home page content", () => {
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

  test("empty state shows when no apps installed", async ({ page }) => {
    await expect(
      page.locator("text=No Applications Installed")
    ).toBeVisible();
  });
});
