import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { setupDeveloperPage, navigateVia } from "./fixtures/helpers";
import { mockNamespaceGraph, type NamespaceGraph } from "./fixtures/namespace-graph";
import { API_ROUTES, MOCK_INSTALLED_APPS, listApplicationsWireBody } from "./fixtures/mock-data";

/**
 * Upgrading a namespace onto a newer release of its application.
 *
 * Core keeps the two steps apart: installing a release is local to this node,
 * and only `POST /groups/:id/upgrade` moves the namespace, to whatever release
 * this node's application row then names (a bundle's id is the same for every
 * release). So the card has to offer the install first and the upgrade after,
 * and the upgrade must name the id the namespace already runs.
 */

const NS_ID = "ns0000000000000000000000000000000000000000000000000000000000002";
const APP = MOCK_INSTALLED_APPS[0]; // only-peers-chat, installed at 0.3.0

function graph(role: string, appVersion = "0.3.0"): NamespaceGraph {
  return {
    namespaceId: NS_ID,
    name: "Workspace",
    applicationId: APP.id,
    appVersion,
    role,
    contexts: [{ contextId: "ctx-1", name: "general" }],
    subgroups: [],
  };
}

interface UpgradeMock {
  installs: unknown[];
  upgrades: unknown[];
  activations: unknown[];
}

/**
 * Registry, install and upgrade routes over the namespace graph. Registered
 * after `mockNamespaceGraph`, so they win: Playwright runs the newest route
 * first.
 */
async function mockUpgrade(
  page: Page,
  opts: { published: string[]; installed: string; upgradeStatus?: "completed" | "in_progress" },
): Promise<UpgradeMock> {
  const mock: UpgradeMock = { installs: [], upgrades: [], activations: [] };
  let installed = opts.installed;
  let upgraded = false;

  await page.route(
    (url) => url.pathname.includes("/api/v2/bundles"),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          opts.published.map((v) => ({ package: "only-peers-chat", appVersion: v, yanked: false })),
        ),
      }),
  );
  await page.route(API_ROUTES.listApplications, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: listApplicationsWireBody([{ ...APP, version: installed }]),
    }),
  );
  await page.route(API_ROUTES.installApplication, (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    mock.installs.push(body);
    installed = body.version;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { applicationId: APP.id } }),
    });
  });
  await page.route(`**/admin-api/groups/${NS_ID}/upgrade`, (route) => {
    mock.upgrades.push(JSON.parse(route.request().postData() ?? "{}"));
    upgraded = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { groupId: NS_ID, status: opts.upgradeStatus ?? "completed" } }),
    });
  });
  // The re-read after Upgrade names the release the node now holds.
  await page.route(
    (url) => url.pathname === `/admin-api/namespaces/${NS_ID}`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            namespaceId: NS_ID,
            appKey: "bytecode-1",
            targetApplicationId: APP.id,
            createdAt: 0,
            memberCount: 2,
            contextCount: 1,
            subgroupCount: 0,
            appVersion: installed,
            appPackage: "only-peers-chat",
          },
        }),
      }),
  );
  await page.route(`**/admin-api/groups/${NS_ID}/upgrade/activate`, (route) => {
    mock.activations.push(JSON.parse(route.request().postData() ?? "{}"));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { targetApplicationId: APP.id, switchedContexts: 1, replayedDeltas: 0, failedContexts: [] },
      }),
    });
  });
  await page.route(`**/admin-api/groups/${NS_ID}/upgrade/status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: upgraded
          ? {
              fromVersion: "0.3.0",
              toVersion: installed,
              initiatedAt: 0,
              initiatedBy: "me",
              status: opts.upgradeStatus ?? "completed",
              localContextsTotal: 3,
              localContextsSwapped: 1,
            }
          : null,
      }),
    }),
  );
  return mock;
}

async function openNamespace(page: Page) {
  await navigateVia(page, "Namespaces");
  await page.locator(`.ns-app-card[data-application-id="${APP.id}"]`).click();
  await page.locator(".ns-card").first().click();
  await expect(page.getByTestId("ns-upgrade-card")).toBeVisible();
}

test.describe("Namespace upgrades", () => {
  test("shows the version the namespace runs, in place of the old upgrade policy", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph("Admin"));
    await mockUpgrade(page, { published: ["0.3.0"], installed: "0.3.0" });
    await openNamespace(page);

    await expect(page.getByTestId("ns-detail-version")).toContainText("v0.3.0");
    await expect(page.getByText("Upgrade Policy")).toHaveCount(0);
    await expect(page.getByTestId("ns-upgrade-current")).toBeVisible();
  });

  test("an admin installs the newer release, then upgrades the namespace to it", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph("Admin"));
    const mock = await mockUpgrade(page, { published: ["0.4.0", "0.3.0"], installed: "0.3.0" });
    await openNamespace(page);

    await expect(page.getByTestId("ns-upgrade-published")).toHaveText("0.4.0");
    // Upgrading first would move the namespace to the release it already runs.
    await expect(page.getByTestId("ns-upgrade-upgrade")).toHaveCount(0);

    await page.getByTestId("ns-upgrade-install").click();
    await expect.poll(() => mock.installs).toEqual([{ package: "only-peers-chat", version: "0.4.0" }]);
    await expect(page.getByTestId("ns-upgrade-installed")).toHaveText("0.4.0");

    await page.getByTestId("ns-upgrade-upgrade").click();
    await expect
      .poll(() => mock.upgrades)
      .toEqual([{ targetApplicationId: APP.id, cascade: true }]);
    await expect.poll(() => mock.activations).toHaveLength(1);
    await expect(page.getByTestId("ns-upgrade-error")).toHaveCount(0);
  });

  test("a running cascade shows its progress on this node", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph("Admin"));
    await mockUpgrade(page, { published: ["0.4.0"], installed: "0.4.0", upgradeStatus: "in_progress" });
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-upgrade").click();
    await expect(page.getByTestId("ns-upgrade-progress")).toContainText("1 of 3 contexts");
    await expect(page.getByTestId("ns-upgrade-error")).toHaveCount(0);
  });

  test("a plain member sees the newer release but is offered no action", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph("Member"));
    await mockUpgrade(page, { published: ["0.4.0"], installed: "0.3.0" });
    await openNamespace(page);

    await expect(page.getByTestId("ns-upgrade-card")).toContainText("An admin of this namespace can upgrade it");
    await expect(page.getByTestId("ns-upgrade-install")).toHaveCount(0);
    await expect(page.getByTestId("ns-upgrade-upgrade")).toHaveCount(0);
  });

  test("an install that derives another application id is refused, not upgraded to", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph("Admin"));
    const mock = await mockUpgrade(page, { published: ["0.4.0"], installed: "0.3.0" });
    await page.route(API_ROUTES.installApplication, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { applicationId: "someone-elses-build" } }),
      }),
    );
    await openNamespace(page);

    await page.getByTestId("ns-upgrade-install").click();
    await expect(page.getByTestId("ns-upgrade-error")).toContainText("installed as a different application");
    expect(mock.upgrades).toEqual([]);
  });
});
