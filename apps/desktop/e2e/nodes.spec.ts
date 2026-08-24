import { test, expect } from "./fixtures/test";
import { describeAfter35 } from "./fixtures/e2e-cap";
import { setupDeveloperPage, navigateVia } from "./fixtures/helpers";

/**
 * Nodes page tests.
 *
 * The Nodes nav item is only shown when developer mode is on (or the node is
 * disconnected). These tests use developer setup so `navigateVia(..., "Nodes")`
 * can reach the page.
 *
 * Node management relies almost entirely on Tauri `invoke` calls (merod binary),
 * so these tests verify UI rendering, form behaviour, and element presence
 * rather than backend side-effects.
 */

describeAfter35("Nodes – page rendering", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Nodes");
    await expect(page.getByTestId("shell-page-title")).toHaveText("Nodes");
  });

  test("renders the Nodes heading", async ({ page }) => {
    await expect(page.getByTestId("shell-page-title")).toHaveText("Nodes");
  });

  test("renders the Connection section", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Connection", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#node-url")).toBeVisible();
  });

  test("renders the Local Nodes section with create card", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Local Nodes", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Create New Node", exact: true }),
    ).toBeVisible();
  });

  test("renders Save Configuration on the connection card", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Save Configuration" }),
    ).toBeVisible();
  });
});

// ─── Data directory (local nodes) ───────────────────────────────────────────

describeAfter35("Nodes – data directory", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Nodes");
  });

  test("Data Directory input defaults to ~/.calimero", async ({ page }) => {
    const homeInput = page.locator("#home-dir");
    await expect(homeInput).toBeVisible();
    await expect(homeInput).toHaveValue("~/.calimero");
  });

  test("Data Directory input is editable", async ({ page }) => {
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
    await setupDeveloperPage(page);
    await navigateVia(page, "Nodes");
  });

  test("node name input and Create button are visible without expanding", async ({
    page,
  }) => {
    await expect(page.locator("#new-node-name")).toBeVisible();
    await expect(
      page.locator(".node-management-card").getByRole("button", { name: "Create" }),
    ).toBeVisible();
  });

  test("node name input accepts text", async ({ page }) => {
    const nameInput = page.locator("#new-node-name");
    await nameInput.fill("my-test-node");
    await expect(nameInput).toHaveValue("my-test-node");
  });

  test("Create button is disabled until name and admin credentials are filled", async ({
    page,
  }) => {
    const createBtn = page
      .locator(".node-management-card")
      .getByRole("button", { name: "Create" });
    await expect(createBtn).toBeDisabled();

    // rc.17: creating a node provisions the admin account at init, so a name
    // alone is no longer enough — admin username + an 8-char password are also
    // required before Create enables.
    await page.locator("#new-node-name").fill("node1");
    await expect(createBtn).toBeDisabled();

    await page.locator("#new-admin-user").fill("admin");
    await page.locator("#new-admin-password").fill("dev-password");
    await expect(createBtn).not.toBeDisabled();
  });
});

// ─── Available nodes section ────────────────────────────────────────────────

describeAfter35("Nodes – available nodes (empty state)", () => {
  test("shows empty message when no nodes exist", async ({ page }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Nodes");

    await expect(
      page.getByText("No nodes found. Create your first node above."),
    ).toBeVisible();
  });
});

// ─── Port inputs ────────────────────────────────────────────────────────────

describeAfter35("Nodes – port inputs (when nodes available)", () => {
  test("port inputs have correct defaults when the select is visible", async ({
    page,
  }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Nodes");

    const serverPortInput = page.locator("#server-port");
    const swarmPortInput = page.locator("#swarm-port");

    if (await serverPortInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(serverPortInput).toHaveValue("2528");
      await expect(swarmPortInput).toHaveValue("2428");
    }
  });
});

// ─── Manage section (only when nodes exist) ─────────────────────────────────

describeAfter35("Nodes – manage section", () => {
  test("Manage Nodes heading appears only when merod reports nodes", async ({
    page,
  }) => {
    await setupDeveloperPage(page);
    await navigateVia(page, "Nodes");

    const manageHeading = page.getByRole("heading", {
      name: "Manage Nodes",
      exact: true,
    });

    if (await manageHeading.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(manageHeading).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Start Node" }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText("No nodes found. Create your first node above."),
      ).toBeVisible();
    }
  });
});

// ─── Back button ────────────────────────────────────────────────────────────

describeAfter35("Nodes – navigation", () => {
  test("Nodes is accessible from the sidebar", async ({ page }) => {
    await setupDeveloperPage(page);

    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar.getByTitle("Nodes")).toBeVisible();

    await sidebar.getByTitle("Nodes").click();
    await expect(page.getByTestId("shell-page-title")).toHaveText("Nodes");
  });
});
