import { test, expect } from "@playwright/test";
import {
  MOCK_CONTEXTS,
  MOCK_INSTALLED_APPS,
  API_ROUTES,
} from "./fixtures/mock-data";
import {
  setupDeveloperPage,
  setupAuthenticatedPage,
  navigateVia,
  mockCoreAPIs,
  mockContextAPIs,
  seedDeveloperState,
} from "./fixtures/helpers";

// ─── Contexts page – listing ────────────────────────────────────────────────

test.describe.only("Contexts – listing", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Contexts");
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();
  });

  test("renders the Contexts heading", async ({ page }) => {
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();
  });

  test("displays contexts fetched from API", async ({ page }) => {
    for (const ctx of MOCK_CONTEXTS) {
      const displayName = ctx.name || ctx.id.substring(0, 16) + "...";
      await expect(
        page.getByText(displayName),
      ).toBeVisible();
    }
  });

  test("shows context IDs in the table (truncated)", async ({ page }) => {
    for (const ctx of MOCK_CONTEXTS) {
      const truncatedId = ctx.id.substring(0, 32);
      await expect(page.getByText(truncatedId, { exact: false })).toBeVisible();
    }
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

  test("each context row has a Delete button", async ({ page }) => {
    const deleteButtons = page.getByRole("button", { name: "Delete" });
    await expect(deleteButtons).toHaveCount(MOCK_CONTEXTS.length);
  });
});

// ─── Contexts page – empty state ────────────────────────────────────────────

test.describe.only("Contexts – empty state", () => {
  test("shows empty message when no contexts exist", async ({ page }) => {
    await mockCoreAPIs(page);
    await mockContextAPIs(page);

    await page.route(API_ROUTES.listContexts, (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { contexts: [] } }),
        });
      }
      return route.continue();
    });

    await page.goto("/");
    await seedDeveloperState(page);
    await page.reload();

    await navigateVia(page, "Contexts");
    await expect(page.getByRole("main").getByRole("heading", { name: "Contexts" })).toBeVisible();
    await expect(page.getByText("No contexts found.")).toBeVisible();
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

    await expect(
      appSelect.locator("option", { hasText: "Select an application..." }),
    ).toBeVisible();

    for (const app of MOCK_INSTALLED_APPS) {
      const meta = JSON.parse(atob(app.metadata as string));
      const displayName = meta.name || app.name || app.id;
      await expect(
        appSelect.locator("option", { hasText: displayName }),
      ).toBeVisible();
    }
  });

  test("form cancel button closes the form", async ({ page }) => {
    await page.locator("button", { hasText: "+ Create Context" }).click();
    await expect(
      page.locator("h2", { hasText: "Create New Context" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
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

    let createCalled = false;
    await page.route(API_ROUTES.createContext, (route) => {
      if (route.request().method() === "POST") {
        createCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              contextId: "ctx-new-123",
            },
          }),
        });
      }
      return route.continue();
    });

    await page.locator("button", { hasText: "+ Create Context" }).click();

    const appSelect = page.locator("#context-application-id");
    await appSelect.selectOption({ index: 1 });

    const requestPromise = page.waitForRequest(
      (req) => req.url().includes("/contexts") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Create Context" }).click();
    await requestPromise;
    expect(createCalled).toBe(true);
  });

  test("submitting with init params sends them as JSON", async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Contexts");

    let requestBody: any = null;
    await page.route(API_ROUTES.createContext, (route) => {
      if (route.request().method() === "POST") {
        requestBody = route.request().postDataJSON();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ data: { contextId: "ctx-new-456" } }),
        });
      }
      return route.continue();
    });

    await page.locator("button", { hasText: "+ Create Context" }).click();
    await page.locator("#context-application-id").selectOption({ index: 1 });
    await page.locator("#context-init-params").fill('{"greeting": "hello"}');

    const requestPromise = page.waitForRequest(
      (req) => req.url().includes("/contexts") && req.method() === "POST",
    );
    await page.getByRole("button", { name: "Create Context" }).click();
    await requestPromise;
    expect(requestBody).not.toBeNull();
  });
});

// ─── Delete context ─────────────────────────────────────────────────────────

test.describe("Contexts – delete flow", () => {
  test("clicking Delete triggers the delete API", async ({ page }) => {
    await setupDeveloperPage(page);
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

    const confirmBtn = page.locator("button", { hasText: /confirm|yes/i });
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }

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
