/**
 * Uninstalling an app: the dialog's two ticks decide, per namespace, whether it
 * is left, deleted for everyone, removed from this device, or kept. These specs
 * assert on the calls the node receives, since a toast over the wrong call is
 * exactly the failure they guard.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { setupAuthenticatedPage, navigateVia, mockRegistryAPIs } from "./fixtures/helpers";
import { MOCK_ACCOUNT_ID, mockNamespaceGraph } from "./fixtures/namespace-graph";

const APP_ID = "installed-app-2";
const OTHER = (n: number) => String(n + 3).repeat(64);

interface MockNamespace {
  id: string;
  name: string;
  role: string;
  /** How many other people are members. */
  others: number;
}

const JOINED: MockNamespace = { id: "ns-joined", name: "Team", role: "Member", others: 3 };
const ALONE: MockNamespace = { id: "ns-alone", name: "Notes", role: "Admin", others: 0 };
const SHARED: MockNamespace = { id: "ns-shared", name: "Family", role: "Admin", others: 2 };

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Serve the app's namespaces and record every write the uninstall makes. */
async function mockNode(
  page: Page,
  namespaces: MockNamespace[],
  opts: { holdsAccountRoot?: boolean; refuse?: Record<string, { status: number; error: string }> } = {},
) {
  const writes: Call[] = [];
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/admin-api/**", (route) => {
    const method = route.request().method();
    const path = new URL(route.request().url()).pathname.replace(/^\/admin-api/, "");
    if (method === "GET") {
      if (path === "/identity") {
        return route.fulfill(
          json({ data: { accountId: MOCK_ACCOUNT_ID, holdsAccountRoot: opts.holdsAccountRoot ?? true } }),
        );
      }
      if (path === `/namespaces/for-application/${APP_ID}`) {
        return route.fulfill(
          json({ data: namespaces.map((ns) => ({ namespaceId: ns.id, name: ns.name, targetApplicationId: APP_ID })) }),
        );
      }
      const members = path.match(/^\/groups\/([^/]+)\/members$/);
      const ns = members && namespaces.find((n) => n.id === members[1]);
      if (ns) {
        const others = Array.from({ length: ns.others }, (_, i) => ({ identity: OTHER(i), role: "Member" }));
        return route.fulfill(json({ members: [{ identity: MOCK_ACCOUNT_ID, role: ns.role }, ...others] }));
      }
      return route.fallback();
    }
    const raw = route.request().postData();
    writes.push({ method, path, ...(raw ? { body: JSON.parse(raw) } : {}) });
    const refusal = opts.refuse?.[`${method} ${path}`];
    if (refusal) return route.fulfill(json({ error: refusal.error }, refusal.status));
    return route.fulfill(json({ data: {} }));
  });
  return writes;
}

async function openDialog(page: Page) {
  await page.locator("[data-testid='installed-app-card']", { hasText: "Blockchain Demo" }).locator(".installed-app-more-btn").click();
  await page.locator(".app-actions-dropdown .dropdown-item", { hasText: "Uninstall" }).click();
  await expect(page.getByRole("heading", { name: "Uninstall Application" })).toBeVisible();
}

async function setup(page: Page, namespaces: MockNamespace[], opts?: Parameters<typeof mockNode>[2]) {
  await setupAuthenticatedPage(page);
  const writes = await mockNode(page, namespaces, opts);
  await navigateVia(page, "Applications");
  await openDialog(page);
  return writes;
}

const deleteData = (page: Page) => page.getByRole("checkbox", { name: /Delete all application data/ });
const leave = (page: Page) => page.getByRole("checkbox", { name: /Also leave shared namespaces/ });
const uninstallButton = (page: Page) => page.locator(".confirm-actions").getByRole("button", { name: "Uninstall" });
const outcomes = (page: Page) => page.getByTestId("uninstall-outcomes").locator("> li");
const tag = (page: Page) => page.getByText("Affects all your devices");
const toast = (page: Page) => page.locator(".toast-message");
const UNINSTALL = { method: "DELETE", path: `/applications/${APP_ID}` };

test.describe("Uninstall dialog", () => {
  test("lists the app's namespaces on this device with our role and who else is in them", async ({ page }) => {
    await setup(page, [JOINED, ALONE]);

    const rows = page.getByTestId("uninstall-namespaces").locator("li");
    await expect(rows).toHaveText(["TeamMember · you and 3 others", "NotesAdmin · only you"]);
  });

  test("by default leaves what we joined and deletes what only we are in", async ({ page }) => {
    const writes = await setup(page, [JOINED, ALONE]);

    await expect(deleteData(page)).toBeChecked();
    await expect(leave(page)).toBeChecked();
    await expect(tag(page)).toBeVisible();
    await expect(outcomes(page)).toHaveText([
      "The app is removed from this device.",
      "Team: you leave it, and all your devices remove it",
      "Notes: deleted; you are its only member",
    ]);

    await uninstallButton(page).click();

    await expect(toast(page)).toHaveText(
      '"Blockchain Demo" uninstalled\nTeam: you leave it, and all your devices remove it\nNotes: deleted; you are its only member',
    );
    expect(writes).toEqual([
      { method: "POST", path: "/namespaces/ns-joined/leave", body: { purge: true } },
      { method: "POST", path: "/groups/ns-alone/owner-delete", body: {} },
      UNINSTALL,
    ]);
  });

  test("without leaving, removes every namespace from this device only", async ({ page }) => {
    const writes = await setup(page, [JOINED, SHARED]);

    await leave(page).uncheck();

    await expect(tag(page)).toHaveCount(0);
    await expect(outcomes(page)).toHaveText([
      "The app is removed from this device.",
      "Team: removed from this device; you stay a member",
      "Family: removed from this device; you stay a member",
    ]);
    await uninstallButton(page).click();

    await expect(toast(page)).toContainText("Family: removed from this device; you stay a member");
    expect(writes).toEqual([
      { method: "DELETE", path: "/namespaces/ns-joined", body: {} },
      { method: "DELETE", path: "/namespaces/ns-shared", body: {} },
      UNINSTALL,
    ]);
  });

  test("keeping the data disables leaving and touches no namespace", async ({ page }) => {
    const writes = await setup(page, [JOINED, SHARED]);

    await deleteData(page).uncheck();

    await expect(leave(page)).toBeDisabled();
    await expect(leave(page)).not.toBeChecked();
    await expect(tag(page)).toHaveCount(0);
    await expect(outcomes(page)).toHaveText([
      "The app is removed from this device.",
      "Team: kept on this device",
      "Family: kept on this device",
    ]);
    await uninstallButton(page).click();

    await expect(toast(page)).toContainText('"Blockchain Demo" uninstalled');
    expect(writes).toEqual([UNINSTALL]);
  });

  test("a namespace we own and share blocks the uninstall until leave is unticked", async ({ page }) => {
    const writes = await setup(page, [SHARED]);

    await expect(outcomes(page).nth(1)).toHaveText(
      /^Family: you own it and 2 others are members; transfer ownership first/,
    );
    await expect(page.getByRole("link", { name: "Transfer ownership" })).toBeVisible();
    await expect(uninstallButton(page)).toBeDisabled();

    await leave(page).uncheck();

    await expect(page.getByRole("link", { name: "Transfer ownership" })).toHaveCount(0);
    await expect(uninstallButton(page)).toBeEnabled();
    expect(writes).toEqual([]);
  });

  test("deleting a shared namespace for everyone needs its name typed", async ({ page }) => {
    const writes = await setup(page, [SHARED]);
    const force = page.getByRole("checkbox", { name: "Delete Family for everyone" });
    const typed = page.getByRole("textbox", { name: "Type Family to confirm" });

    await expect(force).not.toBeChecked();
    await force.check();
    await expect(uninstallButton(page)).toBeDisabled();
    await typed.fill("family");
    await expect(uninstallButton(page)).toBeDisabled();
    await typed.fill("Family");

    await expect(outcomes(page).nth(1)).toHaveText(/^Family: deleted for all 3 members/);
    await uninstallButton(page).click();

    await expect(toast(page)).toContainText("Family: deleted for all 3 members");
    expect(writes).toEqual([{ method: "POST", path: "/groups/ns-shared/owner-delete", body: {} }, UNINSTALL]);
  });

  test("on a linked device, an owned namespace waits for the computer that holds the account", async ({ page }) => {
    const writes = await setup(page, [JOINED, ALONE], { holdsAccountRoot: false });

    await expect(outcomes(page).nth(2)).toContainText("Notes: only the computer that holds the account can delete it");
    await expect(page.getByText('Do this on the computer that holds the account, or untick "Also leave shared namespaces".')).toBeVisible();
    await expect(uninstallButton(page)).toBeDisabled();

    await leave(page).uncheck();
    await uninstallButton(page).click();

    await expect(toast(page)).toContainText("Notes: removed from this device; you stay a member");
    expect(writes).toEqual([
      { method: "DELETE", path: "/namespaces/ns-joined", body: {} },
      { method: "DELETE", path: "/namespaces/ns-alone", body: {} },
      UNINSTALL,
    ]);
  });

  test("a refused step stops before the app is uninstalled, and says where", async ({ page }) => {
    const writes = await setup(page, [JOINED, ALONE], {
      refuse: { "POST /namespaces/ns-joined/leave": { status: 403, error: "the last admin cannot leave" } },
    });

    await uninstallButton(page).click();

    await expect(toast(page)).toHaveText('"Blockchain Demo" was not uninstalled: Team: the last admin cannot leave');
    expect(writes).toEqual([{ method: "POST", path: "/namespaces/ns-joined/leave", body: { purge: true } }]);
  });

  test("a revoked session aborts the uninstall and asks to sign in again", async ({ page }) => {
    const writes = await setup(page, [JOINED]);
    await page.route("**/admin-api/namespaces/ns-joined/leave", (route) =>
      route.fulfill({ status: 401, headers: { "x-auth-error": "token_revoked" }, body: "{}" }),
    );

    await uninstallButton(page).click();

    await expect(page.getByTestId("login-screen")).toBeVisible();
    expect(writes).not.toContainEqual(UNINSTALL);
  });

  test("Transfer ownership opens the Namespaces page's picker for that namespace", async ({ page }) => {
    await setupAuthenticatedPage(page);
    const ns = "ns0000000000000000000000000000000000000000000000000000000000002";
    await mockNamespaceGraph(page, {
      namespaceId: ns,
      name: "Family",
      role: "Admin",
      applicationId: APP_ID,
      otherMembers: [{ identity: OTHER(0), role: "Member", name: "Bob" }],
    });
    // Registered last, so it answers the listing the graph fixture does not model.
    await page.route(`**/admin-api/namespaces/for-application/${APP_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [{ namespaceId: ns, name: "Family", targetApplicationId: APP_ID }] }),
      }),
    );
    await navigateVia(page, "Applications");
    await openDialog(page);

    await page.getByRole("link", { name: "Transfer ownership" }).click();

    await expect(page.locator(".ns-page-top h1")).toHaveText("Family");
    await expect(page.locator(".ns-modal h2")).toHaveText("Transfer Ownership");
  });
});

test.describe("Reinstalling an app", () => {
  test("rejoins the namespaces this device was removed from, and says which", async ({ page }) => {
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    const writes: Call[] = [];
    await page.route("**/admin-api/**", (route) => {
      const method = route.request().method();
      const path = new URL(route.request().url()).pathname.replace(/^\/admin-api/, "");
      const ok = (data: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
      if (method === "GET" && path === "/namespaces/for-application/installed-app-1") {
        return ok([
          { namespaceId: "ns-here", name: "Still here" },
          { namespaceId: "ns-team", name: "Team", forgotten: true },
          { namespaceId: "ns-family", name: "Family", forgotten: true },
        ]);
      }
      if (method === "GET") return route.fallback();
      const raw = route.request().postData();
      writes.push({ method, path, ...(raw ? { body: JSON.parse(raw) } : {}) });
      if (path === "/install-application") return ok({ applicationId: "installed-app-1" });
      return ok({});
    });
    await navigateVia(page, "Marketplace");
    await page.locator("[data-testid='app-card']", { hasText: "Only Peers Chat" }).click();

    await page.getByTestId("detail-install").click();

    await expect(toast(page)).toHaveText(/installed successfully!\nRestored 2 namespaces: Team, Family$/);
    expect(writes.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/install-application", body: expect.anything() },
      { method: "POST", path: "/namespaces/ns-team/join", body: {} },
      { method: "POST", path: "/namespaces/ns-family/join", body: {} },
    ]);
  });
});
