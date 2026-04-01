import { test, expect } from "@playwright/test";
import { describeAfter35 } from "./fixtures/e2e-cap";
import { setupAuthenticatedPage, navigateVia } from "./fixtures/helpers";

/**
 * Nodes page tests.
 *
 * Node management relies almost entirely on Tauri `invoke` calls (merod binary),
 * so these tests verify UI rendering, form behaviour, and element presence
 * rather than backend side-effects.
 */

describeAfter35("Nodes – page rendering", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Nodes");
    await expect(page.locator("h1", { hasText: "Nodes" })).toBeVisible();
  });

  test("renders the Nodes heading", async ({ page }) => {
    await expect(page.locator("h1", { hasText: "Nodes" })).toBeVisible();
  });

  test("renders the Create Node card", async ({ page }) => {
    await expect(page.locator("h2", { hasText: "Create Node" })).toBeVisible();
  });

  test("renders the Available Nodes card", async ({ page }) => {
    await expect(
      page.locator("h2", { hasText: "Available Nodes" }),
    ).toBeVisible();
  });

  test("renders the Running Nodes card", async ({ page }) => {
    await expect(
      page.locator("h2", { hasText: "Running Nodes" }),
    ).toBeVisible();
  });
});

// ─── Home directory ─────────────────────────────────────────────────────────

describeAfter35("Nodes – home directory", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Nodes");
  });

  test("Home Directory input defaults to ~/.calimero", async ({ page }) => {
    const homeInput = page.locator("#home-dir");
    await expect(homeInput).toBeVisible();
    await expect(homeInput).toHaveValue("~/.calimero");
  });

  test("Home Directory input is editable", async ({ page }) => {
    const homeInput = page.locator("#home-dir");
    await homeInput.fill("/tmp/my-nodes");
    await expect(homeInput).toHaveValue("/tmp/my-nodes");
  });

  test("Browse button is present", async ({ page }) => {
    await expect(
      page.locator("button", { hasText: "Browse" }),
    ).toBeVisible();
  });
});

// ─── Create node form ───────────────────────────────────────────────────────

describeAfter35("Nodes – create node form", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Nodes");
  });

  test("'+ Create New Node' button is present", async ({ page }) => {
    await expect(
      page.locator("button.button-primary", { hasText: "+ Create New Node" }),
    ).toBeVisible();
  });

  test("clicking '+ Create New Node' shows the node name input", async ({
    page,
  }) => {
    await page
      .locator("button.button-primary", { hasText: "+ Create New Node" })
      .click();

    await expect(page.locator("#new-node-name")).toBeVisible();
    await expect(
      page.locator("button.button-primary", { hasText: "Create" }),
    ).toBeVisible();
    await expect(
      page.locator("button", { hasText: "Cancel" }),
    ).toBeVisible();
  });

  test("cancel hides the node name input", async ({ page }) => {
    await page
      .locator("button.button-primary", { hasText: "+ Create New Node" })
      .click();
    await expect(page.locator("#new-node-name")).toBeVisible();

    await page
      .locator("button:not(.button-primary)", { hasText: "Cancel" })
      .click();
    await expect(page.locator("#new-node-name")).not.toBeVisible();
  });

  test("node name input accepts text", async ({ page }) => {
    await page
      .locator("button.button-primary", { hasText: "+ Create New Node" })
      .click();

    const nameInput = page.locator("#new-node-name");
    await nameInput.fill("my-test-node");
    await expect(nameInput).toHaveValue("my-test-node");
  });

  test("Create button is disabled when node name is empty", async ({
    page,
  }) => {
    await page
      .locator("button.button-primary", { hasText: "+ Create New Node" })
      .click();

    const createBtn = page.locator("button.button-primary", {
      hasText: "Create",
    });
    await expect(createBtn).toBeDisabled();

    await page.locator("#new-node-name").fill("node1");
    await expect(createBtn).not.toBeDisabled();
  });
});

// ─── Available nodes section ────────────────────────────────────────────────

describeAfter35("Nodes – available nodes (empty state)", () => {
  test("shows empty message when no nodes exist", async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Nodes");

    await expect(
      page.getByText("No nodes found.", { exact: false }),
    ).toBeVisible();
  });
});

// ─── Port inputs ────────────────────────────────────────────────────────────

describeAfter35("Nodes – port inputs (when nodes available)", () => {
  test("port inputs have correct defaults when the select is visible", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Nodes");

    const serverPortInput = page.locator("#server-port");
    const swarmPortInput = page.locator("#swarm-port");

    if (await serverPortInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(serverPortInput).toHaveValue("2528");
      await expect(swarmPortInput).toHaveValue("2428");
    }
  });
});

// ─── Running nodes section ──────────────────────────────────────────────────

describeAfter35("Nodes – running nodes (empty state)", () => {
  test("shows empty message when no nodes are running", async ({ page }) => {
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Nodes");

    await expect(
      page.getByText("No running nodes detected.", { exact: false }),
    ).toBeVisible();
  });
});

// ─── Back button ────────────────────────────────────────────────────────────

describeAfter35("Nodes – navigation", () => {
  test("Nodes is accessible from the sidebar", async ({ page }) => {
    await setupAuthenticatedPage(page);

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar.getByTitle("Nodes")).toBeVisible();

    await sidebar.getByTitle("Nodes").click();
    await expect(page.locator("h1", { hasText: "Nodes" })).toBeVisible();
  });
});
