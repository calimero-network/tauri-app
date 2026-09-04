import { test, expect } from "./fixtures/test";
import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  MOCK_PROVIDERS_RESPONSE,
  MOCK_HEALTH_OK,
  API_ROUTES,
  listApplicationsWireBody,
} from "./fixtures/mock-data";

// A fresh page.goto boots the whole app cold (bundle parse, Tauri IPC probing,
// onboarding-state resolution), which can exceed the default expect timeout.
async function expectWelcomeHeading(page: import("@playwright/test").Page) {
  await expect(
    page.getByRole("heading", { name: /Welcome to Calimero/i }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe("onboarding flow", () => {
  test("fresh profile shows welcome screen", async ({ page }) => {
    await page.goto("/");
    await expectWelcomeHeading(page);
  });

  test("welcome → what-is step via Continue button", async ({ page }) => {
    await page.goto("/");
    await expectWelcomeHeading(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: /Your Data, Your Control/i }),
    ).toBeVisible();
  });

  test("what-is → node-setup step via Get Started", async ({ page }) => {
    await page.goto("/");
    await expectWelcomeHeading(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: /Your Data, Your Control/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Get Started" }).click();
    await expect(
      page.getByRole("heading", { name: /Set Up Your Node/i }),
    ).toBeVisible();
  });

  test("what-is back button returns to welcome", async ({ page }) => {
    await page.goto("/");
    await expectWelcomeHeading(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(
      page.getByRole("heading", { name: /Your Data, Your Control/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Go back" }).click();
    await expect(
      page.getByRole("heading", { name: /Welcome to Calimero/i }),
    ).toBeVisible();
  });

  test("node-setup defaults to create-new form in browser environment", async ({
    page,
  }) => {
    await page.goto("/");
    await expectWelcomeHeading(page);

    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Get Started" }).click();

    await expect(
      page.getByRole("heading", { name: /Set Up Your Node/i }),
    ).toBeVisible();
    // In browser (no Tauri invoke), listMerodNodes fails so the app
    // defaults to nodeSetupMode='create-new', showing the create form
    await expect(
      page.getByText("Create your first Calimero node"),
    ).toBeVisible();
    await expect(page.getByLabel("Data Directory")).toBeVisible();
    // Credentials moved to the auth step; node-setup is config-only and its
    // primary action is now "Continue".
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
  });

  test("seeding onboarding progress to login step shows auth UI", async ({
    page,
  }) => {
    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_HEALTH_OK),
      }),
    );
    await page.route(API_ROUTES.providers, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_PROVIDERS_RESPONSE),
      }),
    );

    await page.goto("/");
    await page.evaluate(
      ([settingsKey, progressKey, settings, progress]) => {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
        localStorage.setItem(progressKey, JSON.stringify(progress));
      },
      [
        STORAGE_KEYS.settings,
        STORAGE_KEYS.onboardingProgress,
        { ...DEFAULT_SETTINGS, nodeUrl: "http://localhost:2528" },
        {
          currentStep: "login",
          dataDir: "~/.calimero",
          nodeName: "default",
          serverPort: 2528,
          swarmPort: 2428,
          nodeSetupMode: "create-new",
          useExistingNode: null,
          nodeCreated: true,
          nodeStarted: true,
          savedAt: Date.now(),
        },
      ] as const,
    );

    // Same cold-boot cost as a fresh goto: this is the app's first render after seeding.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /Set Up Authentication/i }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("seeding completed onboarding skips to main app", async ({ page }) => {
    await page.route(API_ROUTES.health, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_HEALTH_OK),
      }),
    );
    await page.route(API_ROUTES.providers, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_PROVIDERS_RESPONSE),
      }),
    );
    await page.route(API_ROUTES.listApplications, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: listApplicationsWireBody([]),
      }),
    );

    await page.goto("/");
    await page.evaluate(
      ([settingsKey, settings]) => {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
      },
      [
        STORAGE_KEYS.settings,
        { ...DEFAULT_SETTINGS, onboardingCompleted: true },
      ] as const,
    );

    await page.reload();
    // Past onboarding: main shell may still show headings that match "Welcome to Calimero"
    await expect(page.getByTestId("onboarding-page")).toHaveCount(0);
  });
});
