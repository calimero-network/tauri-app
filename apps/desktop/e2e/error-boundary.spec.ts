import { test, expect } from "./fixtures/test";
import { mockCoreAPIs, setupAuthenticatedPage } from "./fixtures/helpers";
import { AUTHENTICATED_SETTINGS, STORAGE_KEYS } from "./fixtures/mock-data";

// Helper: seed settings so the app is past onboarding and boots the root ErrorBoundary
async function seedAndLoad(page: any) {
  await mockCoreAPIs(page);
  await page.goto("/");
  await page.evaluate(
    ([key, val]: [string, any]) => localStorage.setItem(key, JSON.stringify(val)),
    [STORAGE_KEYS.settings, AUTHENTICATED_SETTINGS] as const,
  );
  await page.reload();
}

// Helper: trigger root ErrorBoundary via the test hook exposed in componentDidMount
async function triggerRootError(page: any, message = "Test render error") {
  await page.waitForFunction(() => typeof (window as any).__triggerErrorBoundary === "function", { timeout: 10_000 });
  await page.evaluate((msg: string) => (window as any).__triggerErrorBoundary(msg), message);
}

// ─── Error boundary UI ────────────────────────────────────────────────────────

test.describe("ErrorBoundary — UI", () => {
  test("shows error UI when a render error occurs", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page, "Something exploded");

    await expect(page.getByTestId("error-boundary")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  });

  test("shows the error message in the details block", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page, "Unique error XYZ-123");

    await expect(page.getByTestId("error-boundary-details")).toContainText("Unique error XYZ-123");
  });

  test("shows Try Again, Reload App and Copy Error buttons", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page);

    await expect(page.getByTestId("error-boundary-retry")).toBeVisible();
    await expect(page.getByTestId("error-boundary-reload")).toBeVisible();
    await expect(page.getByTestId("error-boundary-copy")).toBeVisible();
  });
});

// ─── Recovery: Try Again ──────────────────────────────────────────────────────

test.describe("ErrorBoundary — Try Again", () => {
  test("clicking Try Again hides the error UI", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page);

    await expect(page.getByTestId("error-boundary")).toBeVisible();
    await page.getByTestId("error-boundary-retry").click();
    await expect(page.getByTestId("error-boundary")).not.toBeVisible();
  });

  test("clicking Try Again re-renders the app", async ({ page }) => {
    await mockCoreAPIs(page);
    await page.goto("/");
    await page.evaluate(
      ([key, val]: [string, any]) => localStorage.setItem(key, JSON.stringify(val)),
      [STORAGE_KEYS.settings, AUTHENTICATED_SETTINGS] as const,
    );
    await page.reload();

    await triggerRootError(page);
    await page.getByTestId("error-boundary-retry").click();

    // App content should be back — login or main shell visible
    await expect(
      page.locator("aside.sidebar, [data-testid='login-screen']")
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── Recovery: Reload App ─────────────────────────────────────────────────────

test.describe("ErrorBoundary — Reload App", () => {
  test("clicking Reload App navigates away from the error screen", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page);

    await expect(page.getByTestId("error-boundary")).toBeVisible();

    // Set up the navigation listener BEFORE clicking so we don't miss it
    const navPromise = page.waitForNavigation({ timeout: 10_000 }).catch(() => {});
    await page.getByTestId("error-boundary-reload").click();
    await navPromise;

    await expect(page.getByTestId("error-boundary")).not.toBeVisible({ timeout: 10_000 });
  });
});

// ─── Error logging to localStorage ───────────────────────────────────────────

test.describe("ErrorBoundary — error logging", () => {
  test("logs error to calimero-error-log in localStorage", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page, "Logged error ABC");

    // Wait until componentDidCatch has written to localStorage
    await page.waitForFunction(() => localStorage.getItem("calimero-error-log") !== null, { timeout: 5_000 });

    const log = await page.evaluate(() => {
      const raw = localStorage.getItem("calimero-error-log");
      return raw ? JSON.parse(raw) : [];
    });

    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBeGreaterThan(0);
    const last = log[log.length - 1];
    expect(last).toHaveProperty("timestamp");
    expect(last).toHaveProperty("error");
  });

  test("keeps at most 10 entries in error log", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page, "Error log overflow test");

    // Seed 15 pre-existing log entries
    await page.evaluate(() => {
      const entries = Array.from({ length: 15 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        componentName: "Test",
        error: { name: "Error", message: `Error ${i}`, stack: "" },
        componentStack: "",
      }));
      localStorage.setItem("calimero-error-log", JSON.stringify(entries));
    });

    // Trigger another error — should trim to 10
    await page.getByTestId("error-boundary-retry").click();
    await triggerRootError(page, "One more error");

    // Wait for the new entry to be written before checking the cap
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("calimero-error-log");
      if (!raw) return false;
      const entries = JSON.parse(raw);
      return entries.some((e: any) => e.error?.message === "One more error");
    }, { timeout: 5_000 });

    const log = await page.evaluate(() => {
      const raw = localStorage.getItem("calimero-error-log");
      return raw ? JSON.parse(raw) : [];
    });

    expect(log.length).toBeLessThanOrEqual(10);
  });
});

// ─── Copy Error button ────────────────────────────────────────────────────────

test.describe("ErrorBoundary — Copy Error", () => {
  test("Copy Error button is clickable without throwing", async ({ page }) => {
    await seedAndLoad(page);
    await triggerRootError(page, "Copyable error");

    // Grant clipboard permission and click
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await expect(page.getByTestId("error-boundary-copy")).toBeEnabled();
    await page.getByTestId("error-boundary-copy").click();

    // Error UI should still be visible after copy (no crash)
    await expect(page.getByTestId("error-boundary")).toBeVisible();

    // Clipboard should contain the error message that was triggered
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText).toContain("Copyable error");
  });
});

// ─── Authenticated page — boundary wraps sections ────────────────────────────

test.describe("ErrorBoundary — authenticated app sections", () => {
  test("login screen is wrapped — error boundary test hook is registered", async ({ page }) => {
    // Verify root ErrorBoundary hook is always available after app boots
    await mockCoreAPIs(page);
    await page.goto("/");
    await page.evaluate(
      ([key, val]: [string, any]) => localStorage.setItem(key, JSON.stringify(val)),
      [STORAGE_KEYS.settings, AUTHENTICATED_SETTINGS] as const,
    );
    await page.reload();

    const hookExists = await page.waitForFunction(
      () => typeof (window as any).__triggerErrorBoundary === "function",
      { timeout: 10_000 },
    );
    expect(hookExists).toBeTruthy();
  });

  test("app recovers to main shell after error + retry on authenticated page", async ({ page }) => {
    await setupAuthenticatedPage(page);
    await triggerRootError(page, "Crash in main app");

    await expect(page.getByTestId("error-boundary")).toBeVisible();
    await page.getByTestId("error-boundary-retry").click();
    await expect(page.locator("aside.sidebar")).toBeVisible({ timeout: 10_000 });
  });
});
