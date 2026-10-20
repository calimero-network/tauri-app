import { test, expect, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolveMerod, waitFor } from "./nodes";
import {
  contextIds,
  hasNamespace,
  openDesktop,
  openUninstall,
  seedNamespace,
  startWorld,
  state,
  transferToFirstCandidate,
  type World,
} from "./world";
import type { MeroJs } from "@calimero-network/mero-js";

/**
 * A namespace operation schema bump (26 -> 27) rolled out across real nodes: the
 * same data dir restarted on a newer merod, a newer node beside an older peer, and
 * a restart back on the older binary. The older merod is LIVE_OLD_MEROD_BINARY (a
 * release before schema 27); the newer is MEROD_BINARY.
 */

const OLD = process.env["LIVE_OLD_MEROD_BINARY"];
const NEW = resolveMerod();

let w: World;

test.beforeEach(() => {
  test.skip(!OLD, "set LIVE_OLD_MEROD_BINARY to a merod release from before schema 27");
});

test.afterEach(async () => {
  await w?.stop();
});

/** Founded on `merod`, with Bob joined and one context holding state. */
async function foundGuild(merod: string) {
  w = await startWorld(merod);
  const { namespaceId, contextIds: [contextId] } = await seedNamespace(w, "Guild", { members: [w.bob] });
  return { namespaceId, contextId: contextId! };
}

async function write(m: MeroJs, contextId: string, value: string) {
  await m.rpc.execute({ contextId, method: "set", argsJson: { key: "who", value } });
}

async function reads(m: MeroJs, contextId: string, value: string) {
  await waitFor(
    `a node to read ${value}`,
    async () => (await m.rpc.execute({ contextId, method: "get", argsJson: { key: "who" } })) === value || undefined,
    60_000,
    1_000,
  );
}

async function roles(m: MeroJs, namespaceId: string): Promise<string[]> {
  return (await m.admin.listGroupMembers(namespaceId)).members.map((x) => `${x.name}:${x.role}`).sort();
}

async function ownerOpCounter(m: MeroJs, namespaceId: string) {
  return (await m.admin.getGroupInfo(namespaceId)).ownerOpCounter;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Alice, who owns Guild, hands it to Bob from the desktop's uninstall dialog. */
async function aliceTransfersToBob(browser: Browser) {
  const page = await openDesktop(browser, w.nodes.alice.url, state().registryUrl);
  await openUninstall(page, w.applicationId);
  await expect(page.getByTestId("uninstall-outcomes").locator("> li").nth(1)).toHaveText(
    /^Guild: you own it and 1 other is a member; transfer ownership first/,
  );
  await page.getByRole("button", { name: "Transfer ownership" }).click();
  await transferToFirstCandidate(page);
  await expect(page.getByText("Ownership transferred to Bob")).toBeVisible();
}

async function bothStayAdmins(namespaceId: string) {
  for (const m of [w.alice, w.bob]) {
    await waitFor("Alice and Bob to be admins", async () => (await roles(m, namespaceId)).join() === "Alice:Admin,Bob:Admin" || undefined, 60_000);
  }
}

test("1. a data dir upgraded in place stays owned and synced, and a transfer afterwards keeps the founder an admin", async ({ browser }) => {
  const { namespaceId, contextId } = await foundGuild(OLD!);
  const counter = await ownerOpCounter(w.alice, namespaceId);
  const before = await roles(w.alice, namespaceId);
  expect(before).toEqual(["Alice:Admin", "Bob:Member"]);

  await w.restart("alice", NEW);
  expect(await hasNamespace(w.alice, namespaceId)).toBe(true);
  expect(await roles(w.alice, namespaceId)).toEqual(before);
  expect(await ownerOpCounter(w.alice, namespaceId)).toBe(counter);
  expect(await contextIds(w.alice)).toEqual([contextId]);

  // Bob is still on the old binary: the upgraded founder and the old peer still sync.
  await write(w.alice, contextId, "alice-on-new");
  await reads(w.bob, contextId, "alice-on-new");
  await write(w.bob, contextId, "bob-on-old");
  await reads(w.alice, contextId, "bob-on-old");

  await w.restart("bob", NEW);
  expect(await roles(w.bob, namespaceId)).toEqual(before);
  await write(w.alice, contextId, "both-on-new");
  await reads(w.bob, contextId, "both-on-new");

  // The founder is still the owner as far as the desktop can tell, and a transfer leaves her an admin.
  await aliceTransfersToBob(browser);
  await bothStayAdmins(namespaceId);
  await write(w.bob, contextId, "after-transfer");
  await reads(w.alice, contextId, "after-transfer");
});

test("2. a node on the new binary beside a peer on the old one neither crashes nor corrupts, and the peer catches up once upgraded", async ({ browser }) => {
  const { namespaceId, contextId } = await foundGuild(OLD!);
  await w.restart("alice", NEW);

  await aliceTransfersToBob(browser);
  await write(w.alice, contextId, "after-transfer");

  // The old peer may or may not understand the new op, but it must stay up with its data intact and keep syncing.
  await reads(w.bob, contextId, "after-transfer");
  for (const node of [w.nodes.alice, w.nodes.bob]) {
    expect(running(node.pid)).toBe(true);
    expect((await fetch(`${node.url}/admin-api/health`)).ok).toBe(true);
  }
  expect(await hasNamespace(w.bob, namespaceId)).toBe(true);
  expect(await contextIds(w.bob)).toEqual([contextId]);

  await w.restart("bob", NEW);
  await bothStayAdmins(namespaceId);
  await write(w.bob, contextId, "bob-caught-up");
  await reads(w.alice, contextId, "bob-caught-up");
});

test("3. data written by the new binary and restarted on the old one: observed, and the data survives if the node comes up", async ({ browser }) => {
  const { namespaceId, contextId } = await foundGuild(NEW);
  await aliceTransfersToBob(browser);
  await bothStayAdmins(namespaceId);
  await write(w.alice, contextId, "written-on-new");

  let started = true;
  try {
    await w.restart("alice", OLD!);
  } catch (e) {
    started = false;
    const log = readFileSync(w.nodes.alice.log, "utf8").split("\n").slice(-15).join("\n");
    test.info().annotations.push({ type: "rollback", description: `old binary did not start: ${String(e)}\n${log}` });
  }
  test.info().annotations.push({ type: "rollback", description: started ? "old binary started on the new data dir" : "old binary refused the new data dir" });
  if (!started) return;

  expect(await hasNamespace(w.alice, namespaceId)).toBe(true);
  await reads(w.alice, contextId, "written-on-new");
  expect(await roles(w.alice, namespaceId)).toEqual(["Alice:Admin", "Bob:Admin"]);
});
