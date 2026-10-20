import { test, expect, type Page } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import type { LiveState } from "./global-setup";
import { openDesktop } from "./desktop";
import { ADMIN_PASSWORD, ADMIN_USER, waitFor } from "./nodes";

/**
 * Two desktops, two real nodes: an admin upgrades a namespace and a member's
 * node follows.
 *
 * Node A is the namespace's admin and node B a member; each has its own
 * desktop session (its own browser context, so its own settings and tokens).
 * Both nodes fetch releases from the suite's registry, which serves the older
 * and the newer release of one application.
 *
 * What only real nodes show, and this pins:
 * - installing on A changes nothing for the namespace; the upgrade does;
 * - B learns the new target as soon as the op arrives, but fetches the release
 *   (and so can name its version) only when the app is next used on B.
 */

const NS_NAME = "Upgrade test";

const state = (): LiveState => JSON.parse(process.env["LIVE_STATE"] ?? "null") as LiveState;

async function admin(url: string): Promise<MeroJs> {
  const mero = new MeroJs({ baseUrl: url, credentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  await mero.authenticate();
  return mero;
}

async function openNamespace(page: Page, applicationId: string, name: string) {
  await page.locator("aside.sidebar").getByTitle("Namespaces").click();
  await page.locator(`.ns-app-card[data-application-id="${applicationId}"]`).click();
  await page.locator(".ns-card", { hasText: name }).click();
  await expect(page.getByTestId("ns-upgrade-card")).toBeVisible();
}

test("an admin upgrades a namespace from the desktop, and a member's node follows", async ({ browser }) => {
  const live = state();
  const [nodeA, nodeB] = live.nodes;
  const a = await admin(nodeA!.url);
  const b = await admin(nodeB!.url);

  // ── The namespace on the older release, with a member using it ──
  const { applicationId } = await a.admin.installApplication({ package: live.package, version: live.older });
  const { namespaceId } = await a.admin.createNamespace({ applicationId, name: NS_NAME });
  const { contextId } = await a.admin.createContext({ applicationId, groupId: namespaceId, name: "general" });
  const invitation = (await a.admin.createNamespaceInvitation(namespaceId)) as {
    invitation: Parameters<MeroJs["admin"]["joinNamespace"]>[1]["invitation"];
    groupName?: string;
  };
  await b.admin.joinNamespace(namespaceId, invitation);
  await waitFor(
    "the member's node to see the namespace on the older release",
    async () =>
      (await b.admin.listNamespaces()).find((n) => n.namespaceId === namespaceId)?.appVersion === live.older,
    60_000,
  );
  await b.admin.joinContext(contextId);
  await waitFor(
    "the member to write in the context",
    () => b.rpc.execute({ contextId, method: "set", argsJson: { key: "who", value: "member" } }).then(() => true),
    60_000,
    1_000,
  );

  // ── Desktop A: the admin installs the newer release, then upgrades ──
  const pageA = await openDesktop(browser, nodeA!.url, live.registryUrl);
  await openNamespace(pageA, applicationId, NS_NAME);
  await expect(pageA.getByTestId("ns-upgrade-running")).toHaveText(live.older);
  await expect(pageA.getByTestId("ns-upgrade-installed")).toHaveText(live.older);
  await expect(pageA.getByTestId("ns-upgrade-published")).toHaveText(live.newer);
  await expect(pageA.getByTestId("ns-upgrade-upgrade")).toHaveCount(0);

  await pageA.getByTestId("ns-upgrade-install").click();
  await expect(pageA.getByTestId("ns-upgrade-installed")).toHaveText(live.newer);
  // Installed here, and still not the namespace's release.
  await expect(pageA.getByTestId("ns-upgrade-running")).toHaveText(live.older);
  expect((await b.admin.listNamespaces()).find((n) => n.namespaceId === namespaceId)?.appVersion).toBe(live.older);

  await pageA.getByTestId("ns-upgrade-upgrade").click();
  await expect(pageA.getByTestId("ns-detail-version")).toContainText(`v${live.newer}`);
  await expect(pageA.getByTestId("ns-upgrade-running")).toHaveText(live.newer);
  await expect(pageA.getByTestId("ns-upgrade-current")).toBeVisible();

  // ── Desktop B: the member's node has the op, not yet the release ──
  await waitFor(
    "the upgrade to reach the member's node",
    async () => (await b.admin.listNamespaces()).find((n) => n.namespaceId === namespaceId)?.appVersion !== live.older,
    60_000,
  );
  const pageB = await openDesktop(browser, nodeB!.url, live.registryUrl);
  await openNamespace(pageB, applicationId, NS_NAME);
  await expect(pageB.getByTestId("ns-upgrade-unknown")).toBeVisible();
  await expect(pageB.getByTestId("ns-upgrade-install")).toHaveCount(0);
  await expect(pageB.getByTestId("ns-upgrade-upgrade")).toHaveCount(0);

  // The member uses the app: the node fetches the newer release from its own
  // registry and switches the context, and the write still lands.
  await b.rpc.execute({ contextId, method: "set", argsJson: { key: "who", value: "member, upgraded" } });
  expect(await b.rpc.execute({ contextId, method: "get", argsJson: { key: "who" } })).toBe("member, upgraded");

  await pageB.reload();
  await openNamespace(pageB, applicationId, NS_NAME);
  await expect(pageB.getByTestId("ns-detail-version")).toContainText(`v${live.newer}`);
  await expect(pageB.getByTestId("ns-upgrade-running")).toHaveText(live.newer);
  await expect(pageB.getByTestId("ns-upgrade-installed")).toHaveText(live.newer);
  await expect(pageB.getByTestId("ns-upgrade-install")).toHaveCount(0);
  await expect(pageB.getByTestId("ns-upgrade-upgrade")).toHaveCount(0);

  // The admin's node sees the member's write made on the newer release.
  await waitFor(
    "the member's upgraded write to reach the admin's node",
    async () => (await a.rpc.execute({ contextId, method: "get", argsJson: { key: "who" } })) === "member, upgraded",
    60_000,
    1_000,
  );
});
