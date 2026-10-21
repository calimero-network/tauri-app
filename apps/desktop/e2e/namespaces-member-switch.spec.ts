import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { setupDeveloperPage, navigateVia } from "./fixtures/helpers";
import { APP, NS_ID, mockMemberNode } from "./fixtures/member-node";

/**
 * A member's node after an admin upgraded the namespace. The namespace names
 * the new release at once; each context here keeps running the old one until
 * the member switches it.
 */

const SHOTS = "/tmp/e-shots";

async function openNamespace(page: Page) {
  await navigateVia(page, "Namespaces");
  await page.locator(`.ns-app-card[data-application-id="${APP.id}"]`).click();
  await page.locator(".ns-card").first().click();
  await expect(page.getByTestId("ns-upgrade-card")).toBeVisible();
}

test.describe("Member switch", () => {
  test("names the namespace release and what this node runs, and offers the switch", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page);
    await openNamespace(page);

    await expect(page.getByTestId("ns-upgrade-target")).toHaveText("2.0.0");
    await expect(page.getByTestId("ns-upgrade-running")).toHaveText("1.0.0 on 2, 2.0.0 on 1");
    await expect(page.getByTestId("ns-upgrade-behind")).toHaveText(
      "The admin moved this namespace to 2.0.0. 2 of 3 contexts on this node still run an older release.",
    );
    await expect(page.getByTestId("ns-upgrade-switch")).toHaveText("Switch now");
    await expect(page.getByTestId("ns-upgrade-current")).toHaveCount(0);
    await page.getByTestId("ns-upgrade-card").screenshot({ path: `${SHOTS}/card-behind.png` });
  });

  test("switching activates the release the namespace names, then reads as up to date", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(page);
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-switch").click();
    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
    expect(node.installs).toEqual([]);
    expect(node.activations).toEqual([{ expectedApplicationId: APP.id, expectedVersion: "2.0.0" }]);
    await expect(page.getByTestId("ns-upgrade-running")).toHaveText("2.0.0");
    await expect(page.getByTestId("ns-upgrade-switch")).toHaveCount(0);
  });

  test("installs the release first when this node only holds an older one", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(page, { installed: "1.0.0" });
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-switch").click();
    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
    expect(node.installs).toEqual([{ package: "only-peers-chat", version: "2.0.0" }]);
    expect(node.activations).toHaveLength(1);
  });

  test("shows the migration note and a busy button while switching", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/admin-api/groups/*/upgrade/activate", async (route) => {
      await gate;
      await route.fallback();
    });
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-switch").click();
    await expect(page.getByTestId("ns-upgrade-switching")).toHaveText("Migrating your data. Keep Calimero open.");
    await expect(page.getByTestId("ns-upgrade-behind")).toHaveCount(0);
    await expect(page.getByTestId("ns-upgrade-switch")).toBeDisabled();
    await expect(page.getByTestId("ns-upgrade-switch")).toHaveText("Switching...");
    await page.getByTestId("ns-upgrade-card").screenshot({ path: `${SHOTS}/card-switching.png` });
    release();
    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
  });

  test("when the admin moved on meanwhile, shows the new release and does not retry", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(page, { activate: "moved" });
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-switch").click();
    await expect(page.getByTestId("ns-upgrade-moved")).toHaveText(
      "The admin moved this namespace to 3.0.0 while this node was switching.",
    );
    await expect(page.getByTestId("ns-upgrade-behind")).toHaveCount(0);
    await expect(page.getByTestId("ns-upgrade-target")).toHaveText("3.0.0");
    await expect(page.getByTestId("ns-upgrade-switch")).toHaveText("Switch to 3.0.0");
    expect(node.activations).toHaveLength(1);
    await page.getByTestId("ns-upgrade-card").screenshot({ path: `${SHOTS}/card-moved.png` });
  });

  test("warns about contexts that failed to switch and retries them", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(page, { activate: "partial" });
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-switch").click();
    await expect(page.getByTestId("ns-upgrade-switch-failed")).toContainText("1 context failed to switch on this node.");
    await page.getByTestId("ns-upgrade-card").screenshot({ path: `${SHOTS}/card-failed.png` });

    await page.getByTestId("ns-upgrade-switch-retry").click();
    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
    expect(node.activations).toHaveLength(2);
  });

  test("a node already on the namespace release is up to date, with no switch", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockMemberNode(page, {
      held: { "ctx-1": { groupId: NS_ID, version: "2.0.0" } },
    });
    await openNamespace(page);

    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
    await expect(page.getByTestId("ns-upgrade-running")).toHaveText("2.0.0");
    await expect(page.getByTestId("ns-upgrade-switch")).toHaveCount(0);
  });

  test("an admin's Upgrade also switches the admin's own node onto the new release", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(
      page,
      {
        target: "1.0.0",
        installed: "2.0.0",
        held: { "ctx-1": { groupId: NS_ID, version: "1.0.0" } },
      },
      "Admin",
    );
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-upgrade").click();
    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
    expect(node.upgrades).toHaveLength(1);
    expect(node.activations).toEqual([{ expectedApplicationId: APP.id, expectedVersion: "2.0.0" }]);
    await expect(page.getByTestId("ns-upgrade-running")).toHaveText("2.0.0");
    await expect(page.getByTestId("ns-upgrade-switch")).toHaveCount(0);
  });

  test("an admin's own switch that fails after Upgrade warns and retries like any member's", async ({ page }) => {
    await setupDeveloperPage(page);
    const node = await mockMemberNode(
      page,
      {
        target: "1.0.0",
        installed: "2.0.0",
        activate: "partial",
        held: { "ctx-1": { groupId: NS_ID, version: "1.0.0" } },
      },
      "Admin",
    );
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-upgrade").click();
    await expect(page.getByTestId("ns-upgrade-switch-failed")).toContainText("1 context failed to switch on this node.");
    await page.getByTestId("ns-upgrade-switch-retry").click();
    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
    expect(node.activations).toHaveLength(2);
  });
});
