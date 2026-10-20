import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { setupDeveloperPage, stubTauriInvoke, getInvokeCalls } from "./fixtures/helpers";
import { mockMemberNode } from "./fixtures/member-node";

/**
 * Opening an app whose namespace the admin moved to a newer release: this node
 * must switch first, so the app never runs against data from the old release.
 */

const SHOTS = "/tmp/e-shots";

async function launches(page: Page) {
  return (await getInvokeCalls(page)).filter((c) => c.cmd === "open_app_launcher");
}

async function openApp(page: Page) {
  await page.getByTestId("open-app").first().click();
}

test.describe("Upgrade gate", () => {
  test.beforeEach(async ({ page }) => {
    await stubTauriInvoke(page);
  });

  test("blocks the app behind a modal that Escape and the backdrop cannot dismiss", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page);
    await openApp(page);

    const gate = page.getByTestId("upgrade-gate");
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("Only Peers Chat was updated");
    await expect(gate).toContainText(
      "The admin of Workspace moved it to 2.0.0. 2 of 3 of its contexts on this node still run an older release. Update to keep using Only Peers Chat.",
    );
    await gate.screenshot({ path: `${SHOTS}/gate-modal.png` });

    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await expect(gate).toBeVisible();
    expect(await launches(page)).toEqual([]);
  });

  test("Cancel closes the modal and the app is not opened", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page);
    await openApp(page);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("upgrade-gate")).toHaveCount(0);
    expect(await launches(page)).toEqual([]);
  });

  test("Update switches the namespace, then opens the app", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(page);
    await openApp(page);

    await page.getByTestId("upgrade-gate-update").click();
    await expect.poll(async () => (await launches(page)).length).toBe(1);
    await expect(page.getByTestId("upgrade-gate")).toHaveCount(0);
    expect(node.activations).toHaveLength(1);
  });

  test("shows the migration note and no Cancel while updating", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page);
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    await page.route("**/admin-api/groups/*/upgrade/activate", async (route) => {
      await hold;
      await route.fallback();
    });
    await openApp(page);

    await page.getByTestId("upgrade-gate-update").click();
    await expect(page.getByTestId("upgrade-gate")).toContainText("Migrating your data. Keep Calimero open.");
    await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    // The standard inert primary (index.css), once its colour transition has settled.
    await expect(page.getByTestId("upgrade-gate-update")).toHaveCSS("background-color", "rgb(33, 31, 35)");
    await page.getByTestId("upgrade-gate").screenshot({ path: `${SHOTS}/gate-updating.png` });
    release();
    await expect.poll(async () => (await launches(page)).length).toBe(1);
  });

  test("when the admin moved on meanwhile, names the new release and waits for the user", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(page, { activate: "moved" });
    await openApp(page);

    await page.getByTestId("upgrade-gate-update").click();
    await expect(page.getByTestId("upgrade-gate")).toContainText("moved it to 3.0.0");
    await expect(page.getByTestId("upgrade-gate-update")).toHaveText("Update to 3.0.0");
    expect(node.activations).toHaveLength(1);
    expect(await launches(page)).toEqual([]);
  });

  test("a failed update shows why and offers Retry and Cancel", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(page, { activate: "partial" });
    await openApp(page);

    await page.getByTestId("upgrade-gate-update").click();
    await expect(page.getByTestId("upgrade-gate-error")).toContainText("1 context failed to switch on this node.");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(await launches(page)).toEqual([]);
    await page.getByTestId("upgrade-gate").screenshot({ path: `${SHOTS}/gate-error.png` });

    await page.getByTestId("upgrade-gate-update").click();
    await expect.poll(async () => (await launches(page)).length).toBe(1);
    expect(node.activations).toHaveLength(2);
  });

  test("an app that is up to date opens straight away", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page, { held: {} });
    await openApp(page);

    await expect.poll(async () => (await launches(page)).length).toBe(1);
    await expect(page.getByTestId("upgrade-gate")).toHaveCount(0);
  });

  test("a node that cannot say does not block the app", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page);
    await page.route(
      (url) => url.pathname === "/admin-api/namespaces",
      (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
    );
    await openApp(page);

    await expect.poll(async () => (await launches(page)).length).toBe(1);
    await expect(page.getByTestId("upgrade-gate")).toHaveCount(0);
  });
});
