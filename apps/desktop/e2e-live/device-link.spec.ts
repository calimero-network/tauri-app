import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import { NodeBridge } from "./bridge";
import { ADMIN_PASSWORD, ADMIN_USER, freePorts, resolveMerod, waitFor } from "./nodes";

/**
 * A second computer linked from the Account screens reads and writes a private
 * subgroup made after the namespace key rotated, and one made after the link.
 *
 * Every desktop starts at first launch and runs its own node. A joins a
 * namespace only after its founder rotated the key by removing a member.
 */

const APP_PACKAGE = "com.calimero.kv-store"; // any app with `set`/`get`; only writing into a context needs one
const NS_NAME = "linked-device";
const KEY = "note";
const MEMBERS_OPEN_SUBGROUPS = 36; // join open subgroups (4) and create subgroups (32); no screen sets it
const DEVICE_NAME = "second-laptop";
const CONVERGE_MS = 120_000;
const PROOF_DIR = process.env["PROOF_DIR"]; // when set, a full-page screenshot of each step lands here

type Launch = (label: string) => Promise<Page>;

const test = base.extend<{ bridge: NodeBridge; launch: Launch }>({
  bridge: async ({}, use) => {
    const parent = process.env["LIVE_DATA_DIR"] ?? os.tmpdir();
    const bridge = new NodeBridge(resolveMerod(), mkdtempSync(path.join(parent, "device-link-")));
    await use(bridge);
    await bridge.stop();
  },
  launch: async ({ browser, bridge }, use, testInfo) => {
    const pages = new Map<string, Page>();
    await use(async (label) => {
      const context = await browser.newContext();
      await bridge.attach(context);
      const page = await context.newPage();
      pages.set(label, page);
      await firstLaunch(page, path.join(bridge.root, label));
      return page;
    });
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [label, page] of pages) await proof(page, `10-failed-on-${label}`);
    }
  },
});

/** The node behind a desktop, signed in with the account its onboarding created. */
async function admin(url: string): Promise<MeroJs> {
  const mero = new MeroJs({ baseUrl: url, credentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  await mero.authenticate();
  return mero;
}

async function proof(page: Page, name: string) {
  if (!PROOF_DIR) return;
  mkdirSync(PROOF_DIR, { recursive: true });
  await page.screenshot({ path: path.join(PROOF_DIR, `${name}.png`), fullPage: true });
}

/** No screen shows a context's data, so a read's proof is the value the node returned. */
function proofRead(name: string, read: unknown) {
  if (!PROOF_DIR) return;
  mkdirSync(PROOF_DIR, { recursive: true });
  writeFileSync(path.join(PROOF_DIR, `${name}.json`), JSON.stringify({ read }, null, 2));
}

/** Onboarding as a new user runs it: a node of its own in `dataDir`, and an admin account on it. */
async function firstLaunch(page: Page, dataDir: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Get Started" }).click();
  await page.locator("#data-dir").fill(dataDir);
  await page.getByRole("button", { name: "Advanced Options" }).click();
  const [serverPort, swarmPort] = await freePorts(2);
  await page.locator("#server-port").fill(String(serverPort));
  await page.locator("#swarm-port").fill(String(swarmPort));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator("#auth-admin-user").fill(ADMIN_USER);
  await page.locator("#auth-admin-password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Create Node & Sign In" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page.locator("aside.sidebar")).toBeVisible();
}

function go(page: Page, title: string) {
  return page.locator("aside.sidebar").getByTitle(title).click();
}

async function installApp(page: Page) {
  await go(page, "Marketplace");
  await page.getByPlaceholder("Search applications...").fill(APP_PACKAGE);
  await page.getByTestId("app-card").filter({ hasText: APP_PACKAGE }).click();
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("button", { name: "Install again" })).toBeVisible({ timeout: CONVERGE_MS });
}

async function openNamespace(page: Page) {
  await go(page, "Namespaces");
  await page.getByTestId("ns-app-card").filter({ hasText: APP_PACKAGE }).click();
  await page.locator(".ns-card", { hasText: NS_NAME }).click();
}

async function createNamespace(page: Page) {
  await go(page, "Namespaces");
  await page.getByTestId("ns-app-card").filter({ hasText: APP_PACKAGE }).click();
  await page.getByRole("button", { name: "Create Namespace" }).first().click();
  await page.getByPlaceholder("e.g. my-namespace").fill(NS_NAME);
  await page.getByRole("dialog", { name: "Create Namespace" }).getByRole("button", { name: /Create/ }).click();
  await page.locator(".ns-card", { hasText: NS_NAME }).click();
}

async function invite(page: Page): Promise<string> {
  await page.getByTitle("Actions").click();
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByRole("button", { name: "Create Invitation" }).click();
  const payload = await page.locator(".ns-invite-payload").inputValue();
  await page.getByRole("dialog").getByText("Close", { exact: true }).click();
  return payload;
}

async function joinNamespace(page: Page, payload: string) {
  await go(page, "Namespaces");
  await page.getByTitle("Join an existing namespace using an invitation").first().click();
  await page.getByPlaceholder("Paste invitation payload here...").fill(payload);
  await page.getByRole("dialog").getByRole("button", { name: "Join Namespace" }).click();
  await expect(page.getByText("Joined namespace")).toBeVisible({ timeout: CONVERGE_MS });
}

/** Removes the one member that is not this node, once it has shown up. */
async function removeOtherMember(page: Page) {
  const other = page.locator(".ns-member-row").filter({ hasNot: page.locator(".ns-me-badge") });
  await expect(async () => {
    await page.reload();
    await openNamespace(page);
    await expect(other).toHaveCount(1, { timeout: 5_000 });
  }).toPass({ timeout: CONVERGE_MS });
  await other.getByTitle("Remove member").click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  // The count, unlike the rows, is absent while the list reloads, so it proves the removal landed.
  await expect(page.getByRole("heading", { name: "Members (1)" })).toBeVisible({ timeout: CONVERGE_MS });
}

/** A DM: no screen creates a subgroup, adds to one, makes a context in one or writes to a context. */
async function privateSubgroup(node: MeroJs, namespaceId: string, applicationId: string, peerAccount: string, name: string) {
  const { groupId } = await node.admin.createGroupInNamespace(namespaceId, { groupName: name, visibility: "restricted" });
  await node.admin.addGroupMembers(groupId, { members: [{ identity: peerAccount, role: "Member" }] });
  const { contextId } = await node.admin.createContext({ applicationId, groupId, name });
  await node.rpc.execute({ contextId, method: "set", argsJson: { key: KEY, value: `${name}, from A` } });
  return { groupId, contextId };
}

/** The pairing ceremony through the Account screens: invite on A, reply and code on B, confirm on A. */
async function linkDevice(holder: Page, device: Page) {
  await go(holder, "Account");
  await holder.locator("#add-device").click();
  const invite = (await holder.locator("#pair-invite").textContent()) ?? "";
  await proof(holder, "03-a-shows-link-payload");

  await go(device, "Account");
  await device.locator("#pair-invite-input").fill(invite);
  await proof(device, "04-b-enters-payload");
  await device.locator("#pair-init").click();
  const reply = (await device.locator("#pair-reply").textContent()) ?? "";
  await device.locator("#pair-answer-next").click();
  const code = (await device.locator("#pair-confirmation-code").textContent()) ?? "";

  await holder.locator("#pair-next").click();
  await holder.locator("#pair-response").fill(reply);
  await holder.locator("#pair-code").fill(code);
  await holder.locator("#pair-name").fill(DEVICE_NAME);
  await holder.locator("#pair-complete").click();
  await expect(holder.locator("#pair-success")).toBeVisible({ timeout: CONVERGE_MS });
  await holder.locator("#pair-done").click();
  await expect(holder.locator(".account-device-list")).toContainText(DEVICE_NAME, { timeout: CONVERGE_MS });
  await expect(device.locator("#pair-link-state")).toHaveClass(/is-linked/, { timeout: CONVERGE_MS });
  await proof(holder, "05-a-lists-b-as-linked");
}

/** The subgroup and its one context in the namespace tree on `page`, found by id: only the creator's node knows the name. */
async function expectSubgroupInTree(page: Page, dm: { groupId: string; contextId: string }) {
  const row = page.locator(".ns-tree-subgroup", { hasText: dm.groupId.slice(0, 8) });
  await expect(async () => {
    await page.reload();
    await openNamespace(page);
    await expect(row.locator(".ns-tree-count")).toHaveText("1", { timeout: 5_000 });
  }).toPass({ timeout: CONVERGE_MS });
  const expand = row.getByTitle("Expand");
  if (await expand.count()) await expand.click();
  await expect(page.locator(".ns-tree-context", { hasText: dm.contextId.slice(0, 8) })).toBeVisible();
}

function read(node: MeroJs, contextId: string): Promise<unknown> {
  return node.rpc.execute({ contextId, method: "get", argsJson: { key: KEY } });
}

/** No screen joins a context by id or reads one, so B does both through its node. */
async function joinAndRead(device: MeroJs, contextId: string, expected: string) {
  await waitFor("the device to join the context", () => device.admin.joinContext(contextId).then(() => true), CONVERGE_MS, 2_000);
  await waitFor(`the device to read "${expected}"`, async () => (await read(device, contextId)) === expected, CONVERGE_MS, 1_000);
}

test("a device linked from the desktop reads and writes private subgroups made after a key rotation", async ({ bridge, launch }) => {
  test.setTimeout(900_000);
  const pageF = await launch("founder");
  const pageR = await launch("removed");
  const pageA = await launch("a");
  const pageB = await launch("b");
  const f = await admin(bridge.url("founder"));
  const a = await admin(bridge.url("a"));
  const b = await admin(bridge.url("b"));

  // The founder lets members open subgroups, then invites R and removes it, which rotates the key.
  await installApp(pageF);
  await createNamespace(pageF);
  const { namespaceId, targetApplicationId } = (await f.admin.listNamespaces()).find((n) => n.name === NS_NAME)!;
  await f.admin.setDefaultCapabilities(namespaceId, { defaultCapabilities: MEMBERS_OPEN_SUBGROUPS });
  await joinNamespace(pageR, await invite(pageF));
  await removeOtherMember(pageF);

  // A joins only after the rotation, then opens a private subgroup with the founder.
  await joinNamespace(pageA, await invite(pageF));
  await installApp(pageA);
  await proof(pageA, "01-a-joined-namespace-after-key-rotation");
  const founderAccount = (await f.admin.getNodeIdentity()).accountId;
  const before = await privateSubgroup(a, namespaceId, targetApplicationId, founderAccount, "before-link");
  await expectSubgroupInTree(pageA, before);
  await proof(pageA, "02-a-subgroup-and-context-with-write");

  await linkDevice(pageA, pageB);

  await expectSubgroupInTree(pageB, before);
  await proof(pageB, "06-b-sees-subgroup-and-context");
  await joinAndRead(b, before.contextId, "before-link, from A");
  proofRead("07-b-read-a-write", await read(b, before.contextId));

  await b.rpc.execute({ contextId: before.contextId, method: "set", argsJson: { key: KEY, value: "from B" } });
  await waitFor("A to read B's write", async () => (await read(a, before.contextId)) === "from B", CONVERGE_MS, 1_000);
  proofRead("08-a-read-b-write", await read(a, before.contextId));

  const after = await privateSubgroup(a, namespaceId, targetApplicationId, founderAccount, "after-link");
  await expectSubgroupInTree(pageB, after);
  await joinAndRead(b, after.contextId, "after-link, from A");
  await proof(pageB, "09-b-sees-after-link-subgroup");
});
