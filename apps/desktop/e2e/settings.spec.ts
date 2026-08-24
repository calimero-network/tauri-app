import { test, expect } from "./fixtures/test";
import { describeAfter35 } from "./fixtures/e2e-cap";
import {
  setupAuthenticatedPage,
  setupDeveloperPage,
  seedSettings,
  seedAuthTokens,
  mockCoreAPIs,
  scrollSettingsControlIntoView,
} from "./fixtures/helpers";
import {
  STORAGE_KEYS,
  AUTHENTICATED_SETTINGS,
  DEVELOPER_SETTINGS,
  DEFAULT_REGISTRY_URL,
} from "./fixtures/mock-data";

// ─── Navigate to Settings ──────────────────────────────────────────────────

describeAfter35("Settings page access", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("opens settings page via gear button", async ({ page }) => {
    await page.click('button[title="Settings"]');
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toHaveText("Settings");
  });

  test("settings page has General tab active by default", async ({ page }) => {
    await page.click('button[title="Settings"]');
    const generalTab = page.locator(".settings-tab", { hasText: "General" });
    await expect(generalTab).toHaveClass(/active/);
  });

  test("settings page has Registries tab", async ({ page }) => {
    await page.click('button[title="Settings"]');
    await expect(
      page.locator(".settings-tab", { hasText: "Registries" }),
    ).toBeVisible();
  });

  test("Back button returns to previous page", async ({ page }) => {
    await page.click('button[title="Settings"]');
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toHaveText("Settings");

    await page.locator("button", { hasText: "Back" }).click();
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).not.toBeVisible();
  });
});

// ─── General tab — toggles ──────────────────────────────────────────────────

describeAfter35("General tab toggles", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("dark mode toggle is visible", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#theme-toggle");
    await expect(page.locator("#theme-toggle")).toBeVisible();
  });

  test("developer mode toggle is visible", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).toBeVisible();
  });

  test("debug logs toggle is visible", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#debug-logs");
    await expect(page.locator("#debug-logs")).toBeVisible();
  });

  test("developer mode is off by default", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).not.toBeChecked();
  });

  test("toggling developer mode on updates localStorage", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").check();

    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.settings,
    );
    expect(raw).toBeTruthy();
    const settings = JSON.parse(raw!);
    expect(settings.developerMode).toBe(true);
  });

  test("toggling developer mode off updates localStorage", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").check();
    await expect(page.locator("#developer-mode")).toBeChecked();

    await page.locator("#developer-mode").uncheck();
    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.settings,
    );
    const settings = JSON.parse(raw!);
    expect(settings.developerMode).toBe(false);
  });

  test("dark mode toggle changes theme class on body", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#theme-toggle");
    const isChecked = await page.locator("#theme-toggle").isChecked();
    await page.locator("#theme-toggle").click();

    if (isChecked) {
      await expect(page.locator("body")).not.toHaveClass(/dark/);
    } else {
      await expect(page.locator("body")).toHaveClass(/dark/);
    }
  });

  test("debug logs toggle updates localStorage", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#debug-logs");
    const wasChecked = await page.locator("#debug-logs").isChecked();
    await page.locator("#debug-logs").click();

    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.settings,
    );
    const settings = JSON.parse(raw!);
    expect(settings.debugLogs).toBe(!wasChecked);
  });
});

// ─── Developer mode effect on sidebar ───────────────────────────────────────

describeAfter35("Developer mode enables sidebar links", () => {
  test("enabling developer mode reveals Namespaces & Nodes links", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    await expect(page.locator('button[title="Namespaces"]')).not.toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).not.toBeVisible();

    await page.click('button[title="Settings"]');
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").check();

    await page.locator("button", { hasText: "Back" }).click();

    await expect(page.locator('button[title="Namespaces"]')).toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).toBeVisible();
  });

  test("disabling developer mode hides Namespaces & Nodes links", async ({
    page,
  }) => {
    await setupDeveloperPage(page);

    await expect(page.locator('button[title="Namespaces"]')).toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).toBeVisible();

    await page.click('button[title="Settings"]');
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").uncheck();

    await page.locator("button", { hasText: "Back" }).click();

    await expect(page.locator('button[title="Namespaces"]')).not.toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).not.toBeVisible();
  });
});

// ─── Developer mode pre-seeded ──────────────────────────────────────────────

describeAfter35("Developer mode pre-seeded", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await page.click('button[title="Settings"]');
  });

  test("developer mode toggle is checked when pre-seeded", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).toBeChecked();
  });
});

// ─── Registries tab ─────────────────────────────────────────────────────────

describeAfter35("Registries tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
    await page.locator(".settings-tab", { hasText: "Registries" }).click();
  });

  test("Registries tab shows registry URL input and Add button", async ({
    page,
  }) => {
    await expect(page.locator("#registry-url")).toBeVisible();
    await expect(
      page.locator("button", { hasText: "Add" }),
    ).toBeVisible();
  });

  test("Add button is disabled when input is empty", async ({ page }) => {
    await expect(page.locator("#registry-url")).toHaveValue("");
    await expect(
      page.locator("button", { hasText: "Add" }),
    ).toBeDisabled();
  });

  test("Add button is enabled when input has content", async ({ page }) => {
    await page.fill("#registry-url", "https://custom-registry.example.com/");
    await expect(
      page.locator("button", { hasText: "Add" }),
    ).toBeEnabled();
  });

  test("default registry is listed", async ({ page }) => {
    await expect(page.locator(`text=${DEFAULT_REGISTRY_URL}`)).toBeVisible();
  });

  test("adding a registry updates the list", async ({ page }) => {
    const newUrl = "https://custom-registry.example.com/";
    await page.fill("#registry-url", newUrl);
    await page.locator("button", { hasText: "Add" }).click();

    await expect(page.locator(`text=${newUrl}`)).toBeVisible();
  });

  test("adding a registry clears the input", async ({ page }) => {
    await page.fill(
      "#registry-url",
      "https://custom-registry.example.com/",
    );
    await page.locator("button", { hasText: "Add" }).click();

    await expect(page.locator("#registry-url")).toHaveValue("");
  });

  test("removing a registry updates localStorage", async ({ page }) => {
    const newUrl = "https://temp-registry.example.com/";
    await page.fill("#registry-url", newUrl);
    await page.locator("button", { hasText: "Add" }).click();
    await expect(page.locator(`text=${newUrl}`)).toBeVisible();

    const removeButtons = page.locator("button", { hasText: "Remove" });
    const count = await removeButtons.count();
    await removeButtons.nth(count - 1).click();

    await expect(page.locator(`text=${newUrl}`)).not.toBeVisible();
  });
});

// ─── Reset / Nuke sections ──────────────────────────────────────────────────

describeAfter35("Reset and Nuke sections", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("Reset section shows initial button", async ({ page }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Reset settings" }),
    );
    await expect(
      page.locator("button", { hasText: "Reset settings" }),
    ).toBeVisible();
  });

  test("clicking Reset button shows confirmation checkbox", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Reset settings" }),
    );
    await page
      .locator("button", { hasText: "Reset settings" })
      .click();
    await expect(
      page.locator("text=I understand this cannot be undone"),
    ).toBeVisible();
  });

  test("Nuke section shows initial button", async ({ page }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Delete data folder and reset" }),
    );
    await expect(
      page.locator("button", { hasText: "Delete data folder and reset" }),
    ).toBeVisible();
  });

  test("clicking Nuke button shows confirmation checkbox", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Delete data folder and reset" }),
    );
    await page
      .locator("button", { hasText: "Delete data folder and reset" })
      .click();
    await expect(
      page.locator("text=I understand this will permanently"),
    ).toBeVisible();
  });
});

// ─── Tab switching ──────────────────────────────────────────────────────────

describeAfter35("Tab switching", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("switching to Registries tab and back to General preserves state", async ({
    page,
  }) => {
    await page.locator(".settings-tab", { hasText: "Registries" }).click();
    await expect(page.locator("#registry-url")).toBeVisible();
    await expect(page.locator("#developer-mode")).not.toBeVisible();

    await page.locator(".settings-tab", { hasText: "General" }).click();
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).toBeVisible();
    await expect(page.locator("#registry-url")).not.toBeVisible();
  });
});
