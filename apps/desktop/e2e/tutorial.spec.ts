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

/**
 * Step forward until the tour shows `heading`. Waits for each step to be laid out
 * first - the popover is hidden while a step waits for its page - and steps with
 * the arrow key: the popover can still settle as a page finishes loading, and a
 * click aimed at Next would then land on Skip tour.
 */
async function advanceTourTo(page: Page, heading: string): Promise<void> {
  const popover = page.locator(".tutorial-popover");
  for (;;) {
    await expect(popover).toBeVisible();
    if (await popover.getByRole("heading", { name: heading, exact: true }).isVisible()) return;
    await page.keyboard.press("ArrowRight");
  }
}

test.describe("Guided tour", () => {
  test.beforeEach(async ({ page }) => {
    await setupFirstRunPage(page);
  });

  test("shows on first reach of the shell and walks through every page and Settings tab", async ({ page }) => {
    const tour = page.getByTestId("tutorial");
    const next = page.getByTestId("tutorial-next");
    await expect(tour).toBeVisible();
    await expect(tour.getByRole("heading", { name: "Welcome to Calimero Desktop" })).toBeVisible();

    await next.click();
    await expect(tour.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    await expect(page.locator(".tutorial-spotlight")).toBeVisible();

    // Step forward until the tour reaches a heading, checking the app followed it.
    async function advanceTo(heading: string) {
      await advanceTourTo(page, heading);
    }

    await advanceTo("Connection");
    await expect(page.getByTestId("shell-page-title")).toHaveText("Nodes");
    await advanceTo("Join a namespace");
    await expect(page.getByTestId("shell-page-title")).toHaveText("Namespaces");
    await advanceTo("Devices");
    await expect(page.getByTestId("shell-page-title")).toHaveText("Account");
    await advanceTo("Search and filter");
    await expect(page.getByTestId("shell-page-title")).toHaveText("Marketplace");

    await advanceTo("Settings tabs");
    await expect(page.locator(".settings-title")).toBeVisible();
    await advanceTo("Enable Cloud");
    await expect(page.locator("#cloud-enabled")).toBeChecked();
    await advanceTo("Registries");
    await expect(page.getByRole("heading", { name: "Application Registries" })).toBeVisible();
    await advanceTo("AI Agent");
    await expect(page.getByRole("heading", { name: "Connect AI agent" })).toBeVisible();
    await advanceTo("Calimero Cloud");
    await expect(page.locator("[data-tutorial=settings-cloud]")).toBeVisible();

    await advanceTo("You're all set");
    await expect(next).toHaveText("Finish");
    await expect(page.getByTestId("shell-page-title")).toHaveText("Home");
    await next.click();

    await expect(tour).toHaveCount(0);
    expect(await storedTutorialCompleted(page)).toBe(true);
  });

  test("Back returns to the previous page", async ({ page }) => {
    const tour = page.getByTestId("tutorial");
    await advanceTourTo(page, "Nodes");
    await expect(page.getByTestId("shell-page-title")).toHaveText("Nodes");
    await page.keyboard.press("ArrowLeft");
    await expect(tour.getByRole("heading", { name: "Connection indicator" })).toBeVisible();
    await expect(page.getByTestId("shell-page-title")).toHaveText("Home");
  });

  test("closing inside Settings goes back to the app", async ({ page }) => {
    const tour = page.getByTestId("tutorial");
    await advanceTourTo(page, "Settings tabs");
    await page.getByRole("button", { name: "Close tutorial" }).click();
    await expect(tour).toHaveCount(0);
    await waitForAppShellReady(page);
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
