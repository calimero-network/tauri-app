import { test, expect } from "./fixtures/test";
import type { Page } from "@playwright/test";
import {
  mockCoreAPIs,
  seedSettings,
  seedAuthTokens,
  waitForAppShellReady,
  scrollSettingsControlIntoView,
} from "./fixtures/helpers";
import { AUTHENTICATED_SETTINGS, STORAGE_KEYS } from "./fixtures/mock-data";

/** A signed-in user reaching the shell for the first time: tour not seen yet. */
async function setupFirstRunPage(page: Page): Promise<void> {
  await mockCoreAPIs(page);
  await page.goto("/");
  await seedSettings(page, { ...AUTHENTICATED_SETTINGS, tutorialCompleted: false });
  await seedAuthTokens(page);
  await page.evaluate(() => {
    localStorage.setItem("calimero-autostart-default-applied", "1");
  });
  await page.reload();
  await waitForAppShellReady(page);
}

async function storedTutorialCompleted(page: Page): Promise<boolean | undefined> {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "{}").tutorialCompleted,
    STORAGE_KEYS.settings,
  );
}

test.describe("Guided tour", () => {
  test.beforeEach(async ({ page }) => {
    await setupFirstRunPage(page);
  });

  test("shows on first reach of the shell and walks through the steps", async ({ page }) => {
    const tour = page.getByTestId("tutorial");
    await expect(tour).toBeVisible();
    await expect(tour.getByRole("heading", { name: "Welcome to Calimero Desktop" })).toBeVisible();

    await page.getByTestId("tutorial-next").click();
    await expect(tour.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(page.locator(".tutorial-spotlight")).toBeVisible();

    // Step to the end; the last step's button is Finish.
    while ((await page.getByTestId("tutorial-next").textContent()) !== "Finish") {
      await page.getByTestId("tutorial-next").click();
    }
    await expect(tour.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.getByTestId("tutorial-next").click();

    await expect(tour).toHaveCount(0);
    expect(await storedTutorialCompleted(page)).toBe(true);
  });

  test("closes at any step and stays closed after a reload", async ({ page }) => {
    await page.getByTestId("tutorial-next").click();
    await page.getByRole("button", { name: "Close tutorial" }).click();
    await expect(page.getByTestId("tutorial")).toHaveCount(0);

    await page.reload();
    await waitForAppShellReady(page);
    await expect(page.getByTestId("tutorial")).toHaveCount(0);
  });

  test("Escape closes it", async ({ page }) => {
    await expect(page.getByTestId("tutorial")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("tutorial")).toHaveCount(0);
    expect(await storedTutorialCompleted(page)).toBe(true);
  });

  test("can be turned back on from Settings and replays on leaving", async ({ page }) => {
    await page.getByText("Skip tour").click();
    await expect(page.getByTestId("tutorial")).toHaveCount(0);

    await page.click('button[title="Settings"]');
    const toggle = page.locator("#show-tutorial");
    await scrollSettingsControlIntoView(page, toggle);
    await expect(toggle).not.toBeChecked();
    await page.locator('label[for="show-tutorial"]').click();
    await expect(toggle).toBeChecked();

    await page.locator("button", { hasText: "Back" }).click();
    await expect(page.getByTestId("tutorial")).toBeVisible();
  });
});
