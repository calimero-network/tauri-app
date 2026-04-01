import { test, expect } from "@playwright/test";
import { MOCK_CONTEXTS, MOCK_INSTALLED_APPS, API_ROUTES } from "./fixtures/mock-data";
import {
  setupDeveloperPage,
  setupAuthenticatedPage,
  navigateVia,
} from "./fixtures/helpers";

// ─── Contexts page – listing ────────────────────────────────────────────────

test.describe("Contexts – listing", () => {
  test.beforeEach(async ({ page }) => {
    // First-run parity: developer mode on, but no installed apps and no contexts yet.
    await setupDeveloperPage(page, { installedApps: [], contexts: [] });
    await navigateVia(page, "Contexts");
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();
    await expect(page.getByText("No contexts found.")).toBeVisible({ timeout: 15_000 });
  });

  test("renders the Contexts heading", async ({ page }) => {
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();
  });

  test("after developer mode: empty table and no Delete actions when API returns no contexts", async ({
    page,
  }) => {
    const deleteButtons = page.getByRole("button", { name: "Delete" });
    await expect(deleteButtons).toHaveCount(0);
  });

  test("refresh button is present and clickable", async ({ page }) => {
    const refreshBtn = page.locator("button", { hasText: "Refresh" });
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();
  });

  test("Create Context button is present", async ({ page }) => {
    await expect(
      page.locator("button", { hasText: "+ Create Context" }),
    ).toBeVisible();
  });
});

// ─── Contexts listing when node has data (separate from fresh empty state) ──

test.describe("Contexts – listing when API returns contexts", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page, {
      contexts: MOCK_CONTEXTS,
      installedApps: MOCK_INSTALLED_APPS,
    });
    await navigateVia(page, "Contexts");
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();
    await expect(page.getByText("Test Context Alpha")).toBeVisible({ timeout: 15_000 });
  });

  test("displays context names from the API", async ({ page }) => {
    await expect(page.getByText("Test Context Alpha")).toBeVisible();
    await expect(page.getByText("Test Context Beta")).toBeVisible();
  });

  test("displays truncated context IDs in the table", async ({ page }) => {
    await expect(
      page.getByText("ctx-001-abcdef1234567890..."),
    ).toBeVisible();
    await expect(
      page.getByText("ctx-002-1234567890abcdef..."),
    ).toBeVisible();
  });

  test("renders a Delete action per context row", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(
      MOCK_CONTEXTS.length,
    );
  });
});

// ─── Create context form ────────────────────────────────────────────────────

test.describe("Contexts – create form", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Contexts");
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();
  });

  test("clicking '+ Create Context' opens the form", async ({ page }) => {
    await page.locator("button", { hasText: "+ Create Context" }).click();
    await expect(
      page.locator("h2", { hasText: "Create New Context" }),
    ).toBeVisible();
    await expect(page.locator("#context-protocol")).toBeVisible();
    await expect(page.locator("#context-application-id")).toBeVisible();
    await expect(page.locator("#context-init-params")).toBeVisible();
  });

  test("protocol select defaults to NEAR", async ({ page }) => {
    await page.locator("button", { hasText: "+ Create Context" }).click();
    const protocolSelect = page.locator("#context-protocol");
    await expect(protocolSelect).toHaveValue("near");
  });

  test("application ID dropdown lists installed apps", async ({ page }) => {
    await page.locator("button", { hasText: "+ Create Context" }).click();

    const appSelect = page.locator("#context-application-id");
    await expect(appSelect).toBeVisible();

    // Native <option> elements are not "visible" to Playwright inside <select>.
    await expect(
      appSelect.locator("option", { hasText: "Select an application..." }),
    ).toBeAttached();

    for (const app of MOCK_INSTALLED_APPS) {
      const meta = JSON.parse(atob(app.metadata as string));
      const displayName = meta.name || app.name || app.id;
      await expect(
        appSelect.locator("option", { hasText: displayName }),
      ).toBeAttached();
    }
  });

  test("form cancel button closes the form", async ({ page }) => {
    await page.locator("button", { hasText: "+ Create Context" }).click();
    await expect(
      page.locator("h2", { hasText: "Create New Context" }),
    ).toBeVisible();

    await page
      .locator(".create-context-form .form-actions")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(
      page.locator("h2", { hasText: "Create New Context" }),
    ).not.toBeVisible();
  });

  test("header button toggles to 'Cancel' when form is open", async ({
    page,
  }) => {
    const toggleBtn = page.locator("header button.button-primary");
    await expect(toggleBtn).toHaveText("+ Create Context");

    await toggleBtn.click();
    await expect(toggleBtn).toHaveText("Cancel");

    await toggleBtn.click();
    await expect(toggleBtn).toHaveText("+ Create Context");
  });

  test("initialization params textarea accepts JSON", async ({ page }) => {
    await page.locator("button", { hasText: "+ Create Context" }).click();

    const textarea = page.locator("#context-init-params");
    await textarea.fill('{"key": "value", "count": 42}');
    await expect(textarea).toHaveValue('{"key": "value", "count": 42}');
  });
});

// ─── Create context submission ──────────────────────────────────────────────

test.describe("Contexts – create submission", () => {
  test("submitting the form calls the create context API", async ({
    page,
  }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Contexts");
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();

    // Layer on top of mockContextAPIs: same URL glob; newest route runs first when it matches.
    // Asserting via waitForRequest avoids flakes when the default mock handles POST instead.
    await page.route(API_ROUTES.createContext, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              contextId: "ctx-new-123",
              memberPublicKey: "mock-member-pk",
            },
          }),
        });
      }
      return route.continue();
    });

    await page.locator("button", { hasText: "+ Create Context" }).click();

    const appSelect = page.locator("#context-application-id");
    await appSelect.selectOption({ index: 1 });

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().includes("/admin-api/contexts") && req.method() === "POST",
      ),
      page.getByRole("button", { name: "Create Context" }).click(),
    ]);
    expect(request.method()).toBe("POST");
  });

  test("submitting with init params sends them as JSON", async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Contexts");

    await page.route(API_ROUTES.createContext, (route) => {
      if (route.request().method() === "POST") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { contextId: "ctx-new-456", memberPublicKey: "mock-member-pk" },
          }),
        });
      }
      return route.continue();
    });

    await page.locator("button", { hasText: "+ Create Context" }).click();
    await page.locator("#context-application-id").selectOption({ index: 1 });
    await page.locator("#context-init-params").fill('{"greeting": "hello"}');

    const [request] = await Promise.all([
      page.waitForRequest(
        (req) =>
          req.url().includes("/admin-api/contexts") && req.method() === "POST",
      ),
      page.getByRole("button", { name: "Create Context" }).click(),
    ]);
    const requestBody = request.postDataJSON() as {
      initializationParams?: number[];
    };
    expect(requestBody?.initializationParams?.length).toBeGreaterThan(0);
    const decoded = new TextDecoder().decode(
      new Uint8Array(requestBody.initializationParams!),
    );
    expect(JSON.parse(decoded)).toEqual({ greeting: "hello" });
  });
});

// ─── Delete context ─────────────────────────────────────────────────────────

test.describe("Contexts – delete flow", () => {
  test("clicking Delete triggers the delete API", async ({ page }) => {
    await setupDeveloperPage(page, { contexts: MOCK_CONTEXTS });
    await navigateVia(page, "Contexts");
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();

    let deleteCalled = false;
    await page.route(API_ROUTES.deleteContext, (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { success: true } }),
        });
      }
      return route.continue();
    });

    const requestPromise = page.waitForRequest(
      (req) => req.url().includes("/contexts/") && req.method() === "DELETE",
    );
    await page.getByRole("button", { name: "Delete" }).first().click();

    await page.locator(".confirm-action-page .confirm-actions .button-danger").click();

    await requestPromise;
    expect(deleteCalled).toBe(true);
  });
});

// ─── Contexts require developer mode ────────────────────────────────────────

test.describe("Contexts – requires developer mode", () => {
  test("Contexts link is not in sidebar without developer mode", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTitle("Contexts")).not.toBeVisible();
  });

  test("Contexts link appears in sidebar with developer mode", async ({
    page,
  }) => {
    await setupDeveloperPage(page);

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByTitle("Contexts")).toBeVisible();
  });
});
