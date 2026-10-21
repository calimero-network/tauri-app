import { expect, type Page } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import path from "node:path";
import os from "node:os";
import type { LiveState } from "./global-setup";
import { openDesktop } from "./desktop";
import { ADMIN_PASSWORD, ADMIN_USER, resolveMerod, restartNode, startNodes, stopNodes, waitFor, type LiveNode } from "./nodes";

export { openDesktop };

export const state = (): LiveState => JSON.parse(process.env["LIVE_STATE"] ?? "null") as LiveState;

export async function admin(url: string): Promise<MeroJs> {
  const mero = new MeroJs({ baseUrl: url, credentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  await mero.authenticate();
  return mero;
}

/** The uninstall dialog for an app, opened from its card in the Applications page. */
export async function openUninstall(page: Page, applicationId: string): Promise<void> {
  await page.locator("aside.sidebar").getByTitle("Applications").click();
  const card = page.locator(`[data-testid='installed-app-card'][data-app-id='${applicationId}']`);
  await card.locator(".installed-app-more-btn").click();
  await page.locator(".app-actions-dropdown .dropdown-item", { hasText: "Uninstall" }).click();
  await expect(page.getByRole("heading", { name: "Uninstall Application" })).toBeVisible();
  await expect(page.getByTestId("uninstall-namespaces")).toBeVisible();
}

/** In the open transfer picker: choose the first member and confirm. */
export async function transferToFirstCandidate(page: Page): Promise<void> {
  await page.locator(".ns-modal").getByRole("radio").first().check();
  await page.locator(".ns-modal").getByRole("button", { name: "Continue" }).click();
  await page.locator(".ns-delete-confirm-btn").click();
}

/** A full-page screenshot, written only when LIVE_SHOTS_DIR is set. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env["LIVE_SHOTS_DIR"];
  if (!dir) return;
  // A dialog still fading in would be captured half-dimmed.
  await page.evaluate(() =>
    Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)),
  );
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true, animations: "disabled" });
}

/** The per-test world: fresh nodes, so no test inherits another's namespaces or forgotten markers. */
export interface World {
  /** The account that owns the shared namespaces. */
  alice: MeroJs;
  /** The account the desktop acts as, on its primary device. */
  bob: MeroJs;
  /** Bob's second device, paired into his account. */
  bobLinked: MeroJs;
  nodes: { alice: LiveNode; bob: LiveNode; bobLinked: LiveNode };
  applicationId: string;
  /** What each account is called in the member lists. */
  names: Map<MeroJs, string>;
  /** Restarts one node on `merod`, same data dir, and replaces its client and entry in `nodes`. */
  restart(who: "alice" | "bob", merod: string): Promise<void>;
  stop(): Promise<void>;
}

let slot = 0;

/** Three fresh nodes, with the app installed on each. */
export async function startWorld(merod: string = resolveMerod()): Promise<World> {
  const live = state();
  const dataDir = path.join(process.env["LIVE_DATA_DIR"] ?? path.join(os.tmpdir(), "desktop-live-e2e"), `world-${++slot}`);
  const nodes = await startNodes({
    merod,
    dataDir,
    count: 3,
    registryUrl: live.registryUrl,
  });
  try {
    return await prepareWorld(nodes);
  } catch (e) {
    await stopNodes(nodes.map((n) => n.pid));
    throw e;
  }
}

async function prepareWorld(nodes: LiveNode[]): Promise<World> {
  const live = state();
  const [alice, bob, bobLinked] = await Promise.all(nodes.map((n) => admin(n.url)));
  const release = { package: live.package, version: live.older };
  const [{ applicationId }] = await Promise.all([alice!, bob!, bobLinked!].map((m) => m.admin.installApplication(release)));

  const identity = await bob!.admin.getNodeIdentity();
  // A fresh mesh can be too quiet to carry the certificate on the first try; each try mints a new device.
  await waitFor(
    "Bob's second device to pair",
    async () => {
      const init = await bobLinked!.admin.initAccountPairing({
        accountRootPublicKey: identity.accountRootPublicKey!,
        accountNamespace: identity.accountNamespaceId ?? undefined,
        namespaces: [],
      });
      await bob!.admin.completeAccountPairing({
        deviceId: init.deviceId,
        kemPublicKey: init.kemPublicKey,
        signPublicKey: init.signPublicKey,
        statement: init.statement,
        confirmationCode: init.confirmationCode,
      });
      return true;
    },
    120_000,
    2_000,
  );

  const world: World = {
    alice: alice!,
    bob: bob!,
    bobLinked: bobLinked!,
    nodes: { alice: nodes[0]!, bob: nodes[1]!, bobLinked: nodes[2]! },
    applicationId,
    names: new Map([
      [alice!, "Alice"],
      [bob!, "Bob"],
      [bobLinked!, "Bob"],
    ]),
    async restart(who, merod) {
      const next = await restartNode(world.nodes[who], merod);
      const client = await admin(next.url);
      world.names.set(client, world.names.get(world[who])!);
      world.nodes[who] = next;
      world[who] = client;
    },
    stop: () => stopNodes(Object.values(world.nodes).map((n) => n.pid)),
  };
  return world;
}

export interface Seeded {
  namespaceId: string;
  contextIds: string[];
}

/**
 * A namespace of `owner`'s with `contexts` contexts holding state, joined by every
 * member in `members`, who each read that state before this returns.
 */
export async function seedNamespace(
  w: World,
  name: string,
  opts: { owner?: MeroJs; members?: MeroJs[]; contexts?: number } = {},
): Promise<Seeded> {
  const owner = opts.owner ?? w.alice;
  const { applicationId } = w;
  const { namespaceId } = await owner.admin.createNamespace({ applicationId, name });
  const contextIds: string[] = [];
  for (let i = 0; i < (opts.contexts ?? 1); i++) {
    const { contextId } = await owner.admin.createContext({ applicationId, groupId: namespaceId, name: `ctx-${i + 1}` });
    await owner.rpc.execute({ contextId, method: "set", argsJson: { key: "who", value: name } });
    contextIds.push(contextId);
  }
  for (const member of opts.members ?? []) {
    const invitation = (await owner.admin.createNamespaceInvitation(namespaceId)) as Parameters<
      MeroJs["admin"]["joinNamespace"]
    >[1];
    await member.admin.joinNamespace(namespaceId, invitation);
    await waitFor(`a member to see ${name}`, async () => (await hasNamespace(member, namespaceId)) || undefined, 60_000);
    for (const contextId of contextIds) {
      await member.admin.joinContext(contextId);
      await waitFor(
        `a member to read ${name}`,
        async () => (await member.rpc.execute({ contextId, method: "get", argsJson: { key: "who" } })) === name,
        60_000,
        1_000,
      );
    }
  }
  const everyone = 1 + (opts.members ?? []).length;
  const accounts = [owner, ...(opts.members ?? [])];
  for (const account of accounts) {
    const { accountId } = await account.admin.getNodeIdentity();
    // Members cannot rename themselves by default, so the owner names everyone.
    await owner.admin.setMemberMetadata(namespaceId, accountId, { name: w.names.get(account)! });
  }
  for (const member of accounts) {
    await waitFor(
      `a member to list all ${everyone} members of ${name}, by name`,
      async () => {
        const { members } = await member.admin.listGroupMembers(namespaceId);
        return (members.length === everyone && members.every((m) => m.name)) || undefined;
      },
      60_000,
    );
  }
  return { namespaceId, contextIds };
}

export async function hasNamespace(m: MeroJs, namespaceId: string): Promise<boolean> {
  return (await m.admin.listNamespaces()).some((n) => n.namespaceId === namespaceId);
}

/** What the node lists for the app, forgotten ones included, by id. */
export async function appNamespaces(m: MeroJs, applicationId: string) {
  return (await m.admin.listNamespacesForApplication(applicationId)).map((n) => ({
    id: n.namespaceId,
    forgotten: (n as { forgotten?: boolean }).forgotten === true,
  }));
}

export async function contextIds(m: MeroJs): Promise<string[]> {
  return ((await m.admin.getContexts()).contexts ?? []).map((c) => c.id);
}

/** Whether `m` can still read `contextId`'s state: a purged context cannot run anything. */
export async function canRead(m: MeroJs, contextId: string): Promise<boolean> {
  try {
    await m.rpc.execute({ contextId, method: "get", argsJson: { key: "who" } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this merod has the uninstall outcomes: removing a namespace from a
 * device leaves a restorable marker the node lists as `forgotten`. Probed on a
 * throwaway node, since only a node's own answer says what it can do.
 */
export async function nodeSupportsUninstallOutcomes(): Promise<boolean> {
  const live = state();
  const [node] = await startNodes({
    merod: resolveMerod(),
    dataDir: path.join(process.env["LIVE_DATA_DIR"] ?? path.join(os.tmpdir(), "desktop-live-e2e"), "probe"),
    count: 1,
    registryUrl: live.registryUrl,
  });
  try {
    const m = await admin(node!.url);
    const { applicationId } = await m.admin.installApplication({ package: live.package, version: live.older });
    const { namespaceId } = await m.admin.createNamespace({ applicationId, name: "probe" });
    await m.admin.deleteNamespace(namespaceId);
    return (await appNamespaces(m, applicationId)).some((n) => n.id === namespaceId && n.forgotten);
  } finally {
    await stopNodes([node!.pid]);
  }
}

export async function appInstalled(m: MeroJs, applicationId: string): Promise<boolean> {
  const { apps } = await m.admin.listApplications();
  return (apps ?? []).some((a) => ((a as { id?: string }).id ?? (a as { applicationId?: string }).applicationId) === applicationId);
}
