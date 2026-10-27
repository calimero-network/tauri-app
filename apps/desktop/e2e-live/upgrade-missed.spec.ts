import { test, expect } from "@playwright/test";
import type { MeroJs } from "@calimero-network/mero-js";
import type { LiveState } from "./global-setup";
import { admin, openDesktop, openNamespace } from "./desktop";
import { waitFor } from "./nodes";

/**
 * A member that missed two upgrades switches in one click.
 *
 * The admin upgrades v1 -> v2 -> v3 while the member installs nothing, so the
 * member's node lacks both releases. The switch must install each, oldest
 * first, before it activates; activating v3 with v2 missing is refused.
 */

const NS_NAME = "Two missed upgrades";

const state = (): LiveState => JSON.parse(process.env["LIVE_STATE"] ?? "null") as LiveState;

test("a member that missed two upgrades switches from the namespace card", async ({ browser }) => {
  const live = state();
  test.skip(!live.middle, "needs three releases of the app");
  const [nodeA, nodeB] = live.nodes;
  const a = await admin(nodeA!.url);
  const b = await admin(nodeB!.url);

  const { applicationId } = await a.admin.installApplication({ package: live.package, version: live.older });
  const { namespaceId } = await a.admin.createNamespace({ applicationId, name: NS_NAME });
  const { contextId } = await a.admin.createContext({ applicationId, groupId: namespaceId, name: "general" });
  const invitation = (await a.admin.createNamespaceInvitation(namespaceId)) as {
    invitation: Parameters<MeroJs["admin"]["joinNamespace"]>[1]["invitation"];
  };
  await b.admin.joinNamespace(namespaceId, invitation);
  await waitFor(
    "the member to join the context",
    async () => {
      await b.admin.joinContext(contextId);
      return true;
    },
    60_000,
    1_000,
  );

  for (const version of [live.middle!, live.newer]) {
    await a.admin.installApplication({ package: live.package, version });
    await a.admin.upgradeGroup(namespaceId, { targetApplicationId: applicationId, cascade: true });
    await waitFor(
      `the admin's namespace to name ${version}`,
      async () => (await a.admin.listNamespaces()).find((n) => n.namespaceId === namespaceId)?.appVersion === version,
      60_000,
      1_000,
    );
    await a.admin.activateGroupUpgrade(namespaceId, { expectedApplicationId: applicationId, expectedVersion: version });
  }
  await a.rpc.execute({ contextId, method: "set", argsJson: { key: "who", value: "admin, on the newest" } });

  await waitFor(
    "the member's node to name the newest release",
    async () => (await b.admin.listNamespaces()).find((n) => n.namespaceId === namespaceId)?.appVersion === live.newer,
    60_000,
    1_000,
  );
  expect((await b.admin.getContext(contextId)).applicationVersion).toBe(live.older);

  const page = await openDesktop(browser, nodeB!.url, live.registryUrl);
  await openNamespace(page, applicationId, NS_NAME);
  await expect(page.getByTestId("ns-upgrade-running")).toHaveText(live.older);
  await page.getByTestId("ns-upgrade-switch").click();
  await expect(page.getByTestId("ns-upgrade-current")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("ns-upgrade-running")).toHaveText(live.newer);
  expect((await b.admin.getContext(contextId)).applicationVersion).toBe(live.newer);
  await waitFor(
    "the member to read the admin's write on the newest release",
    async () => (await b.rpc.execute({ contextId, method: "get", argsJson: { key: "who" } })) === "admin, on the newest",
    60_000,
    1_000,
  );
});
