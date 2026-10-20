import { test, expect, type Page } from "@playwright/test";
import { waitFor } from "./nodes";
import {
  appInstalled,
  appNamespaces,
  canRead,
  contextIds,
  hasNamespace,
  nodeSupportsUninstallOutcomes,
  openDesktop,
  openUninstall,
  seedNamespace,
  shot,
  startWorld,
  transferToFirstCandidate,
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

const openUninstallDialog = (page: Page) => openUninstall(page, w.applicationId);

/** What the node now lists, as the Namespaces page shows it. */
async function shotNodeState(page: Page, name: string) {
  await page.locator("aside.sidebar").getByTitle("Namespaces").click();
  await expect(page.getByText("Loading namespaces")).toHaveCount(0);
  await shot(page, name);
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
  await shotNodeState(page, "1-default-leave-node-state");

  // Purged here, and on the account's other device; Alice no longer lists Bob.
  expect(await hasNamespace(w.bob, namespaceId)).toBe(false);
  expect(await contextIds(w.bob)).toEqual([]);
  expect(await canRead(w.bob, contextId!)).toBe(false);
  await waitFor("the second device to purge Family", async () => ((await contextIds(w.bobLinked)).length === 0 && !(await hasNamespace(w.bobLinked, namespaceId))) || undefined, 60_000);
  const aliceMembers = (await w.alice.admin.listGroupMembers(namespaceId)).members;
  expect(aliceMembers).toHaveLength(1);
  // Left, not removed from this device: nothing is waiting to be restored.
  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([]);
  expect(await appInstalled(w.bob, w.applicationId)).toBe(false);

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
  await shotNodeState(page, "2-remove-here-node-state");

  // Gone from this device's disk, flagged for restore, and still Bob's in Alice's view.
  expect(await hasNamespace(w.bob, namespaceId)).toBe(false);
  expect(await contextIds(w.bob)).toEqual([]);
  expect(await canRead(w.bob, contextId!)).toBe(false);
  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([{ id: namespaceId, forgotten: true }]);
  expect(await appInstalled(w.bob, w.applicationId)).toBe(false);
  expect((await w.alice.admin.listGroupMembers(namespaceId)).members).toHaveLength(2);
  // The account's other device is not asked to remove anything.
  expect(await hasNamespace(w.bobLinked, namespaceId)).toBe(true);
  expect(await contextIds(w.bobLinked)).toHaveLength(1);

  await reinstallFromMarketplace(page);
  // The marker keeps the name, so the toast names the namespace.
  await expect(toast(page).filter({ hasText: "installed successfully" })).toHaveText(/Restored 1 namespace: Team$/);
  await shot(page, "2-remove-here-restored");
  await shotNodeState(page, "2-remove-here-restored-node-state");

  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([{ id: namespaceId, forgotten: false }]);
  await waitFor("the data to sync back", async () => (await canRead(w.bob, contextId!)) || undefined, 60_000, 1_000);
  expect(await w.bob.rpc.execute({ contextId: contextId!, method: "get", argsJson: { key: "who" } })).toBe("Team");
  expect((await w.alice.admin.listGroupMembers(namespaceId)).members).toHaveLength(2);
});

test("3. leaving from a second device purges the account's primary device too", async ({ browser }) => {
  const { namespaceId, contextIds: [contextId] } = await seedNamespace(w, "Club", { members: [w.bob] });
  await waitFor("Bob's second device to hold Club", async () => (await hasNamespace(w.bobLinked, namespaceId)) || undefined, 60_000);
  const page = await openDesktop(browser, w.nodes.bobLinked.url, state().registryUrl);

  await openUninstallDialog(page);
  await expect(page.getByTestId("uninstall-namespaces").locator("li")).toHaveText(["ClubMember · you and 1 other"]);
  await shot(page, "3-leave-on-second-device-dialog");
  await uninstallButton(page).click();
  await expect(toast(page)).toContainText("Club: you leave it, and all your devices remove it");
  await shot(page, "3-leave-on-second-device-after");
  await shotNodeState(page, "3-leave-on-second-device-node-state");

  expect(await hasNamespace(w.bobLinked, namespaceId)).toBe(false);
  expect(await contextIds(w.bobLinked)).toEqual([]);
  await waitFor(
    "the primary device to purge Club",
    async () => ((await contextIds(w.bob)).length === 0 && !(await hasNamespace(w.bob, namespaceId))) || undefined,
    60_000,
  );
  expect(await canRead(w.bob, contextId!)).toBe(false);
  expect(await appNamespaces(w.bob, w.applicationId)).toEqual([]);
  expect(await appInstalled(w.bobLinked, w.applicationId)).toBe(false);
  expect((await w.alice.admin.listGroupMembers(namespaceId)).members).toHaveLength(1);
});

test("4. cancelling the dialog changes nothing on any node", async ({ browser }) => {
  const { namespaceId, contextIds: [contextId] } = await seedNamespace(w, "Kept", { members: [w.bob] });
  await waitFor("Bob's second device to hold Kept", async () => (await hasNamespace(w.bobLinked, namespaceId)) || undefined, 60_000);
  const page = await openDesktop(browser, w.nodes.bob.url, state().registryUrl);

  await openUninstallDialog(page);
  await page.locator(".confirm-actions").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Uninstall Application" })).toHaveCount(0);
  await expect(page.locator(`[data-testid='installed-app-card'][data-app-id='${w.applicationId}']`)).toBeVisible();
  await shot(page, "4-cancel-after");

  for (const m of [w.bob, w.bobLinked]) {
    expect(await appNamespaces(m, w.applicationId)).toEqual([{ id: namespaceId, forgotten: false }]);
    expect(await contextIds(m)).toEqual([contextId]);
    expect(await canRead(m, contextId!)).toBe(true);
  }
  expect((await w.alice.admin.listGroupMembers(namespaceId)).members).toHaveLength(2);
  expect(await appInstalled(w.bob, w.applicationId)).toBe(true);
});

const outcomes = (page: Page) => page.getByTestId("uninstall-outcomes").locator("> li");

for (const contexts of [0, 1]) {
  const where = contexts ? " (holding a context)" : "";
  test(`5${contexts ? "b" : ""}. an owner is blocked, transfers ownership on the Namespaces page and stays an admin, and the new owner then deletes it${where}`, async ({ browser }) => {
    const { namespaceId } = await seedNamespace(w, "Studio", { members: [w.bob], contexts });
    const alicePage = await openDesktop(browser, w.nodes.alice.url, state().registryUrl);

    await openUninstallDialog(alicePage);
    await expect(outcomes(alicePage).nth(1)).toHaveText(
      /^Studio: you own it and 1 other is a member; transfer ownership first/,
    );
    await expect(uninstallButton(alicePage)).toBeDisabled();
    await expect(alicePage.getByTestId("uninstall-summary")).toHaveText("Resolve 1 namespace above to continue.");
    await shot(alicePage, `5${contexts ? "b" : ""}-owner-blocked-dialog`);

    await alicePage.getByRole("button", { name: "Transfer ownership" }).click();
    await expect(alicePage.locator(".ns-modal h2")).toHaveText("Transfer Ownership");
    await expect(alicePage.locator(".ns-modal").getByRole("radio")).toHaveCount(1);
    await expect(alicePage.locator(".ns-modal .ns-transfer-hint")).toHaveText(
      "The new owner can delete the namespace for everyone. You stay an admin.",
    );
    await shot(alicePage, `5${contexts ? "b" : ""}-owner-transfer-picker`);
    await transferToFirstCandidate(alicePage);
    await expect(alicePage.getByText("Ownership transferred to Bob")).toBeVisible();
    await shot(alicePage, `5${contexts ? "b" : ""}-owner-transferred`);

    // Alice stays an admin, on her node and on Bob's, and her node lists no stale entry.
    for (const node of [w.alice, w.bob]) {
      await waitFor(
        "both members to be admins",
        async () => {
          const { members } = await node.admin.listGroupMembers(namespaceId);
          return (
            members.length === 2 && members.every((m) => m.role === "Admin") && members.map((m) => m.name).sort().join() === "Alice,Bob"
          ) || undefined;
        },
        60_000,
      );
    }
    expect((await w.alice.admin.listNamespaces()).filter((n) => n.namespaceId === namespaceId)).toHaveLength(1);
    await expect(w.alice.admin.ownerDeleteGroup(namespaceId)).rejects.toMatchObject({ status: 403 });

    const bobPage = await openDesktop(browser, w.nodes.bob.url, state().registryUrl);
    await openUninstallDialog(bobPage);
    if (contexts) {
      await expect(bobPage.getByRole("checkbox", { name: "Delete Studio for everyone" })).toHaveCount(0);
      await expect(bobPage.getByRole("button", { name: "Transfer ownership" })).toBeVisible();
      await expect(uninstallButton(bobPage)).toBeDisabled();
      await shot(bobPage, "5b-new-owner-no-delete-dialog");
      return;
    }
    await bobPage.getByRole("checkbox", { name: "Delete Studio for everyone" }).check();
    await bobPage.getByRole("textbox", { name: "Type Studio to confirm" }).fill("Studio");
    await expect(outcomes(bobPage).nth(1)).toHaveText(/^Studio: deleted for both members/);
    await shot(bobPage, `5${contexts ? "b" : ""}-new-owner-delete-dialog`);
    await uninstallButton(bobPage).click();
    await expect(toast(bobPage)).toContainText("Studio: deleted for both members", { timeout: 15_000 });
    await shot(bobPage, `5${contexts ? "b" : ""}-new-owner-deleted`);

    expect(await hasNamespace(w.bob, namespaceId)).toBe(false);
    expect(await appNamespaces(w.bob, w.applicationId)).toEqual([]);
    expect(await appInstalled(w.bob, w.applicationId)).toBe(false);
    await waitFor("the delete to reach Alice's node", async () => (!(await hasNamespace(w.alice, namespaceId))) || undefined, 60_000);
  });
}

for (const contexts of [0, 1]) {
  const where = contexts ? " (holding a context)" : "";
  test(`6${contexts ? "b" : ""}. an owner deletes a shared namespace for everyone, after typing its name${where}`, async ({ browser }) => {
    const { namespaceId } = await seedNamespace(w, "Roadmap", { members: [w.bob], contexts });
    const page = await openDesktop(browser, w.nodes.alice.url, state().registryUrl);

    await openUninstallDialog(page);
    await expect(uninstallButton(page)).toBeDisabled();
    if (contexts) {
      await expect(page.getByRole("checkbox", { name: "Delete Roadmap for everyone" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Transfer ownership" })).toBeVisible();
      await shot(page, "6b-owner-no-delete-dialog");
      return;
    }
    await page.getByRole("checkbox", { name: "Delete Roadmap for everyone" }).check();
    await expect(uninstallButton(page)).toBeDisabled();
    await page.getByRole("textbox", { name: "Type Roadmap to confirm" }).fill("Roadmap");
    await expect(outcomes(page).nth(1)).toHaveText(/^Roadmap: deleted for both members/);
    await shot(page, `6${contexts ? "b" : ""}-delete-for-everyone-dialog`);
    await uninstallButton(page).click();
    await expect(toast(page)).toContainText("Roadmap: deleted for both members");
    await shot(page, `6${contexts ? "b" : ""}-delete-for-everyone-after`);
    await shotNodeState(page, `6${contexts ? "b" : ""}-delete-for-everyone-node-state`);

    expect(await hasNamespace(w.alice, namespaceId)).toBe(false);
    expect(await appInstalled(w.alice, w.applicationId)).toBe(false);
    // The delete was published: the member's node drops the namespace too, with nothing to restore.
    await waitFor("the delete to reach Bob's node", async () => (!(await hasNamespace(w.bob, namespaceId))) || undefined, 60_000);
    expect(await appNamespaces(w.bob, w.applicationId)).toEqual([]);
  });
}

test("7. an owner who is alone in a namespace deletes it with no prompt", async ({ browser }) => {
  const { namespaceId } = await seedNamespace(w, "Notes", { contexts: 0 });
  const page = await openDesktop(browser, w.nodes.alice.url, state().registryUrl);

  await openUninstallDialog(page);
  await expect(outcomes(page).nth(1)).toHaveText("Notes: deleted; you are its only member");
  await expect(page.getByRole("checkbox", { name: /Delete Notes for everyone/ })).toHaveCount(0);
  await expect(uninstallButton(page)).toBeEnabled();
  await shot(page, "7-owner-alone-dialog");
  await uninstallButton(page).click();
  await expect(toast(page)).toContainText("Notes: deleted; you are its only member");
  await shot(page, "7-owner-alone-after");

  expect(await hasNamespace(w.alice, namespaceId)).toBe(false);
  expect(await appNamespaces(w.alice, w.applicationId)).toEqual([]);
  expect(await appInstalled(w.alice, w.applicationId)).toBe(false);
});

test("8. on a second device, what only the account's owner can do waits for the primary device", async ({ browser }) => {
  const { namespaceId } = await seedNamespace(w, "Mine", { owner: w.bob, members: [w.alice], contexts: 0 });
  await waitFor("Bob's second device to hold Mine", async () => (await hasNamespace(w.bobLinked, namespaceId)) || undefined, 60_000);
  const page = await openDesktop(browser, w.nodes.bobLinked.url, state().registryUrl);

  await openUninstallDialog(page);
  await expect(outcomes(page).nth(1)).toContainText("Mine: only the computer that holds the account can delete it");
  await expect(page.getByText('Do this on the computer that holds the account, or untick "Also leave shared namespaces".')).toBeVisible();
  await expect(uninstallButton(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Transfer ownership" })).toHaveCount(0);
  await shot(page, "8-second-device-blocked-dialog");

  // The node agrees: the second device holds no account root to sign an owner-only op with.
  await expect(w.bobLinked.admin.ownerDeleteGroup(namespaceId)).rejects.toMatchObject({ status: 403 });
  expect(await hasNamespace(w.bob, namespaceId)).toBe(true);

  // Ticking leave off is allowed: it only removes the namespace from this device.
  await page.getByRole("checkbox", { name: /Also leave shared namespaces/ }).uncheck();
  await uninstallButton(page).click();
  await expect(toast(page)).toContainText("Mine: removed from this device; you stay a member");
  await shot(page, "8-second-device-remove-after");
  expect(await hasNamespace(w.bobLinked, namespaceId)).toBe(false);
  expect(await appNamespaces(w.bobLinked, w.applicationId)).toEqual([{ id: namespaceId, forgotten: true }]);
  expect(await hasNamespace(w.bob, namespaceId)).toBe(true);
});

test("7b. an owner who is alone in a namespace that holds a context is blocked, and removes it from this device without leaving", async ({ browser }) => {
  const { namespaceId } = await seedNamespace(w, "Journal", { contexts: 1 });
  const page = await openDesktop(browser, w.nodes.alice.url, state().registryUrl);

  await openUninstallDialog(page);
  await expect(outcomes(page).nth(1)).toContainText(
    "Journal: you are its only member, and a namespace that holds data cannot be deleted",
  );
  await expect(
    page.getByText('Untick "Also leave shared namespaces" to remove it from this device and stay its owner.'),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Delete Journal for everyone/ })).toHaveCount(0);
  await expect(uninstallButton(page)).toBeDisabled();
  await shot(page, "7b-owner-alone-with-context-blocked-dialog");

  await page.getByRole("checkbox", { name: /Also leave shared namespaces/ }).uncheck();
  await expect(uninstallButton(page)).toBeEnabled();
  await uninstallButton(page).click();
  await expect(toast(page)).toContainText("Journal: removed from this device; you stay a member", { timeout: 15_000 });
  await shot(page, "7b-owner-alone-with-context-after");

  expect(await hasNamespace(w.alice, namespaceId)).toBe(false);
  expect(await appNamespaces(w.alice, w.applicationId)).toEqual([{ id: namespaceId, forgotten: true }]);
});
