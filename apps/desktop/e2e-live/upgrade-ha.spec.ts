import { test, expect } from "@playwright/test";
import type { MeroJs } from "@calimero-network/mero-js";
import type { LiveState } from "./global-setup";
import { restartNode, stopNode, waitFor, type LiveNode } from "./nodes";
import { admin, openDesktop, openNamespace } from "./desktop";

/**
 * An upgrade must not cut a namespace's high-availability node off from what
 * is written after it.
 *
 * Node A is the admin's laptop, node H an always-on node that only replicates
 * (as a TEE node does: nobody runs the app on it), node B a member. The admin
 * upgrades from the desktop and writes; then the laptop closes, and B, which was
 * offline throughout, comes back with H as its only peer. What the admin wrote
 * on the new release must reach B through H. Neither H nor B runs the new
 * release until it is switched: H as a sidecar does, B from its namespace card.
 */

const NS_NAME = "Upgrade with an HA node";

const state = (): LiveState => JSON.parse(process.env["LIVE_STATE"] ?? "null") as LiveState;

const read = (mero: MeroJs, contextId: string) =>
  mero.rpc.execute({ contextId, method: "get", argsJson: { key: "who" } });
const write = (mero: MeroJs, contextId: string, value: string) =>
  mero.rpc.execute({
    contextId,
    method: "set",
    argsJson: { key: "who", value },
  });

test("what the admin writes after an upgrade reaches a member through the HA node", async ({ browser }) => {
  const live = state();
  const [nodeA, nodeB, nodeH] = live.nodes;
  const a = await admin(nodeA!.url);
  const b = await admin(nodeB!.url);
  const h = await admin(nodeH!.url);

  // ── A channel, as chat makes one: a context in an open subgroup ──
  const { applicationId } = await a.admin.installApplication({
    package: live.package,
    version: live.older,
  });
  const { namespaceId } = await a.admin.createNamespace({
    applicationId,
    name: NS_NAME,
  });
  const { groupId } = await a.admin.createGroupInNamespace(namespaceId, {
    groupName: "general",
    visibility: "open",
  });
  const { contextId } = await a.admin.createContext({
    applicationId,
    groupId,
    name: "general",
  });

  for (const [mero, who] of [
    [h, "the HA node"],
    [b, "the member"],
  ] as const) {
    const invitation = (await a.admin.createNamespaceInvitation(namespaceId)) as {
      invitation: Parameters<MeroJs["admin"]["joinNamespace"]>[1]["invitation"];
    };
    await mero.admin.joinNamespace(namespaceId, invitation);
    await waitFor(
      `${who} to join the channel`,
      async () => {
        await mero.admin.syncGroup(namespaceId).catch(() => {});
        await mero.admin.joinContext(contextId);
        return true;
      },
      90_000,
      1_000,
    );
  }
  await waitFor("the member to write", () => write(b, contextId, "member").then(() => true), 60_000, 1_000);
  await waitFor("the admin to read the member's write", async () => (await read(a, contextId)) === "member", 60_000);

  // ── The member goes offline; the admin upgrades from the desktop and writes ──
  // Every node is brought back at the end: the suite's other specs share them.
  const down = new Set<LiveNode>();
  const offline = async (node: LiveNode) => {
    await stopNode(node);
    down.add(node);
  };
  const online = async (node: LiveNode) => {
    down.delete(node);
    return admin((await restartNode(live.merod, node)).url);
  };
  try {
    await offline(nodeB!);

    const pageA = await openDesktop(browser, nodeA!.url, live.registryUrl);
    await openNamespace(pageA, applicationId, NS_NAME);
    await pageA.getByTestId("ns-upgrade-install").click();
    await expect(pageA.getByTestId("ns-upgrade-installed")).toHaveText(live.newer);
    await pageA.getByTestId("ns-upgrade-upgrade").click();
    await expect(pageA.getByTestId("ns-upgrade-running")).toHaveText(live.newer);

    await write(a, contextId, "admin, after the upgrade");

    // The HA node runs nothing until it is switched; that is the sidecar's step:
    // install the target release, then activate it, guarded by id and version.
    await waitFor(
      "the upgrade to reach the HA node",
      async () => (await h.admin.listNamespaces()).find((n) => n.namespaceId === namespaceId)?.appVersion === live.newer,
      60_000,
      1_000,
    );
    await h.admin.installApplication({ package: live.package, version: live.newer });
    const switched = await h.admin.activateGroupUpgrade(namespaceId, {
      expectedApplicationId: applicationId,
      expectedVersion: live.newer,
    });
    expect(switched.failedContexts).toEqual([]);
    expect((await h.admin.getContext(contextId)).applicationVersion).toBe(live.newer);
    const stateHash = async (mero: MeroJs) => (await mero.admin.getContext(contextId)).contextStateHash;
    await waitFor(
      "the HA node to take the admin's post-upgrade write",
      async () => (await stateHash(h)) === (await stateHash(a)),
      60_000,
      1_000,
    );

    // ── The laptop closes; the member comes back with only the HA node to sync from ──
    await offline(nodeA!);
    const backB = await online(nodeB!);

    // The member's desktop switches as a member does: Switch now on the namespace card.
    const pageB = await openDesktop(browser, nodeB!.url, live.registryUrl);
    await openNamespace(pageB, applicationId, NS_NAME);
    await expect(pageB.getByTestId("ns-upgrade-target")).toHaveText(live.newer, { timeout: 90_000 });
    await pageB.getByTestId("ns-upgrade-switch").click();
    await expect(pageB.getByTestId("ns-upgrade-current")).toBeVisible({ timeout: 120_000 });
    expect((await backB.admin.getContext(contextId)).applicationVersion).toBe(live.newer);
    await waitFor(
      "the member to read the admin's post-upgrade write",
      async () => (await read(backB, contextId)) === "admin, after the upgrade",
      90_000,
      1_000,
    );
  } finally {
    for (const node of down) await restartNode(live.merod, node);
  }
});
