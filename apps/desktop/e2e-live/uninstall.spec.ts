import { test, expect, type Page } from "@playwright/test";
import { waitFor } from "./nodes";
import {
  appNamespaces,
  canRead,
  contextIds,
  hasNamespace,
  nodeSupportsUninstallOutcomes,
  openDesktop,
  seedNamespace,
  shot,
  startWorld,
  state,
  type World,
} from "./world";

/**
 * Uninstalling an app from the desktop, against real nodes. Alice owns the shared
 * namespaces; Bob is who the desktop acts as, with a second device of his own.
 * Every test asserts what the nodes hold, not only what the dialog said.
 */

let w: World;
let supported = false;

test.beforeAll(async () => {
  supported = await nodeSupportsUninstallOutcomes();
});

test.beforeEach(async () => {
  test.skip(!supported, "this merod does not keep a restorable marker for a namespace removed from a device");
  w = await startWorld();
});

test.afterEach(async () => {
  await w?.stop();
});

const uninstallButton = (page: Page) => page.locator(".confirm-actions").getByRole("button", { name: "Uninstall" });
const toast = (page: Page) => page.locator(".toast-message");

async function openUninstallDialog(page: Page) {
  await page.locator("aside.sidebar").getByTitle("Applications").click();
  const card = page.locator(`[data-testid='installed-app-card'][data-app-id='${w.applicationId}']`);
  await card.locator(".installed-app-more-btn").click();
  await page.locator(".app-actions-dropdown .dropdown-item", { hasText: "Uninstall" }).click();
  await expect(page.getByRole("heading", { name: "Uninstall Application" })).toBeVisible();
  await expect(page.getByTestId("uninstall-namespaces")).toBeVisible();
}

async function reinstallFromMarketplace(page: Page) {
  await page.locator("aside.sidebar").getByTitle("Marketplace").click();
  await page.locator("[data-testid='app-card']").first().click();
  await page.getByTestId("detail-install").click();
}

test("1. the default leaves the namespace on every device of the account, and a reinstall does not bring it back", async ({ browser }) => {
  const { namespaceId, contextIds: [contextId] } = await seedNamespace(w, "Family", { members: [w.bob] });
  await waitFor("Bob's second device to hold Family", async () => (await hasNamespace(w.bobLinked, namespaceId)) || undefined, 60_000);
  const page = await openDesktop(browser, w.nodes.bob.url, state().registryUrl);

  await openUninstallDialog(page);
  await expect(page.getByTestId("uninstall-namespaces").locator("li")).toHaveText(["FamilyMember · you and 1 other"]);
  await shot(page, "1-default-leave-dialog");
  await uninstallButton(page).click();
  await expect(toast(page)).toContainText("Family: you leave it, and all your devices remove it");
  await shot(page, "1-default-leave-after");

  // Purged here, and on the account's other device; Alice no longer lists Bob.
  expect(await hasNamespace(w.bob, namespaceId)).toBe(false);
  expect(await contextIds(w.bob)).toEqual([]);
  expect(await canRead(w.bob, contextId!)).toBe(false);
  await waitFor("the second device to purge Family", async () => ((await contextIds(w.bobLinked)).length === 0 && !(await hasNamespace(w.bobLinked, namespaceId))) || undefined, 60_000);
  const aliceMembers = (await w.alice.admin.listGroupMembers(namespaceId)).members;
  expect(aliceMembers).toHaveLength(1);
  // Left, not removed from this device: nothing is waiting to be restored.
  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([]);
  expect((await w.bob.admin.listApplications()).apps.some((a) => (a as { applicationId?: string }).applicationId === w.applicationId)).toBe(false);

  await reinstallFromMarketplace(page);
  const installed = toast(page).filter({ hasText: "installed successfully" });
  await expect(installed).toBeVisible();
  await expect(installed).not.toContainText("Restored");
  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([]);
  await shot(page, "1-default-leave-reinstalled");
});

test("2. remove from this device only: purged here, still a member, and a reinstall restores it with its data", async ({ browser }) => {
  const { namespaceId, contextIds: [contextId] } = await seedNamespace(w, "Team", { members: [w.bob] });
  await waitFor("Bob's second device to hold Team", async () => (await hasNamespace(w.bobLinked, namespaceId)) || undefined, 60_000);
  const page = await openDesktop(browser, w.nodes.bob.url, state().registryUrl);

  await openUninstallDialog(page);
  await page.getByRole("checkbox", { name: /Also leave shared namespaces/ }).uncheck();
  await expect(page.getByTestId("uninstall-outcomes").locator("> li").nth(1)).toHaveText(
    "Team: removed from this device; you stay a member",
  );
  await shot(page, "2-remove-here-dialog");
  await uninstallButton(page).click();
  await expect(toast(page)).toContainText("Team: removed from this device; you stay a member");
  await shot(page, "2-remove-here-after");

  // Gone from this device's disk, flagged for restore, and still Bob's in Alice's view.
  expect(await hasNamespace(w.bob, namespaceId)).toBe(false);
  expect(await contextIds(w.bob)).toEqual([]);
  expect(await canRead(w.bob, contextId!)).toBe(false);
  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([{ id: namespaceId, forgotten: true }]);
  expect((await w.alice.admin.listGroupMembers(namespaceId)).members).toHaveLength(2);
  // The account's other device is not asked to remove anything.
  expect(await hasNamespace(w.bobLinked, namespaceId)).toBe(true);
  expect(await contextIds(w.bobLinked)).toHaveLength(1);

  await reinstallFromMarketplace(page);
  // The marker keeps no name, so the toast names the namespace by its id.
  await expect(toast(page).filter({ hasText: "installed successfully" })).toContainText(
    `Restored 1 namespace: ${namespaceId.slice(0, 8)}`,
  );
  await shot(page, "2-remove-here-restored");

  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([{ id: namespaceId, forgotten: false }]);
  await waitFor("the data to sync back", async () => (await canRead(w.bob, contextId!)) || undefined, 60_000, 1_000);
  expect(await w.bob.rpc.execute({ contextId: contextId!, method: "get", argsJson: { key: "who" } })).toBe("Team");
  expect((await w.alice.admin.listGroupMembers(namespaceId)).members).toHaveLength(2);
});
