// Transfer ownership from the Namespaces page. Asserts on the calls made, not only
// the toasts: success claimed over a refused transfer is what these guard against.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { setupDeveloperPage, navigateVia, waitForAppShellReady } from "./fixtures/helpers";
import {
  MOCK_ACCOUNT_ID,
  OTHER_ACCOUNT_ID,
  mockNamespaceGraph,
  type GraphFailures,
  type NamespaceGraph,
} from "./fixtures/namespace-graph";

const NS_ID = "ns0000000000000000000000000000000000000000000000000000000000001";
const BOB_ID = "3".repeat(64);

function graph(over: Partial<NamespaceGraph> = {}): NamespaceGraph {
  return {
    namespaceId: NS_ID,
    name: "Design Review",
    role: "Admin",
    contexts: [],
    subgroups: [],
    otherMembers: [
      { identity: BOB_ID, role: "Member", name: "Bob" },
      { identity: OTHER_ACCOUNT_ID, role: "Admin", name: "Alice" },
    ],
    ...over,
  };
}

const ROADMAP_ID = "ns0000000000000000000000000000000000000000000000000000000000002";
const roadmap = (): NamespaceGraph => ({
  namespaceId: ROADMAP_ID,
  name: "Roadmap",
  role: "Admin",
  otherMembers: [{ identity: "5".repeat(64), role: "Member", name: "Dave" }],
});

/** Follow the in-app link, as the uninstall flow will. */
async function followLink(page: Page, id: string) {
  await page.evaluate((ns) => {
    history.pushState(null, "", `?transferNamespace=${ns}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, id);
}

async function openNamespace(page: Page, g: NamespaceGraph, failures?: GraphFailures) {
  await setupDeveloperPage(page);
  const mock = await mockNamespaceGraph(page, g, failures);
  await navigateVia(page, "Namespaces");
  await page.locator('.ns-app-card[data-application-id="installed-app-1"]').click();
  await page.locator(".ns-card").first().click();
  await expect(page.locator(".ns-member-row").first()).toBeVisible();
  return mock;
}

async function openPicker(page: Page) {
  await page.locator(".ns-actions-menu-btn").click();
  await page.locator(".ns-actions-menu").getByText("Transfer Ownership").click();
  await expect(page.locator(".ns-modal h2")).toHaveText("Transfer Ownership");
}

const picker = (page: Page) => page.locator(".ns-modal");
const choose = (page: Page, name: string) => picker(page).getByRole("radio", { name: new RegExp(name) }).check();
const next = (page: Page) => picker(page).getByRole("button", { name: "Continue" }).click();

test.describe("Transfer ownership", () => {
  test("hands the namespace to an admin in one call", async ({ page }) => {
    const mock = await openNamespace(page, graph());
    await openPicker(page);

    await choose(page, "Alice");
    await next(page);
    await expect(page.locator(".ns-delete-msg")).toHaveText(
      'Transfer ownership of "Design Review" to Alice?',
    );
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Ownership transferred to Alice")).toBeVisible();
    expect(mock.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /admin-api/groups/${NS_ID}/transfer-ownership`,
    ]);
    expect(mock.calls.find((c) => c.path.endsWith("/transfer-ownership"))?.body).toEqual({
      newOwner: OTHER_ACCOUNT_ID,
    });
  });

  test("makes a plain member an admin, then transfers, behind one confirmation", async ({ page }) => {
    const mock = await openNamespace(page, graph());
    await openPicker(page);

    await expect(picker(page).locator(".ns-transfer-hint")).toHaveText(
      "The new owner can delete the namespace for everyone. You are removed from its members.",
    );
    await choose(page, "Bob");
    await next(page);
    await expect(page.locator(".ns-delete-msg")).toHaveText(
      'Make Bob an admin and transfer ownership of "Design Review" to them?',
    );
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Ownership transferred to Bob")).toBeVisible();
    expect(mock.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /admin-api/groups/${NS_ID}/transfer-ownership`,
      `PUT /admin-api/groups/${NS_ID}/members/${BOB_ID}/role`,
      `POST /admin-api/groups/${NS_ID}/transfer-ownership`,
    ]);
  });

  test("offers everyone but you, admins first", async ({ page }) => {
    await openNamespace(page, graph());
    await openPicker(page);

    const names = await picker(page).locator(".ns-transfer-option").allTextContents();
    expect(names).toHaveLength(2);
    expect(names[0]).toContain("Alice");
    expect(names[1]).toContain("Bob");
    await expect(picker(page).getByText(MOCK_ACCOUNT_ID.slice(0, 8))).toHaveCount(0);
    await expect(picker(page).getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("says so when nobody else can take over", async ({ page }) => {
    await openNamespace(page, graph({ otherMembers: [] }));
    await openPicker(page);

    await expect(picker(page)).toContainText("No other member can take over yet.");
    await expect(picker(page).getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("says plainly that the member stays an admin when the transfer is refused", async ({ page }) => {
    const mock = await openNamespace(page, graph(), {
      transferAfterPromotion: { status: 403, message: "only the owner can transfer this group" },
    });
    await openPicker(page);
    await choose(page, "Bob");
    await next(page);
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(
      page.getByText(
        "Bob is now an admin, but ownership was not transferred: only the owner can transfer this group",
      ),
    ).toBeVisible();
    await expect(page.getByText("Ownership transferred")).toHaveCount(0);
    await expect(page.locator(".ns-modal")).toHaveCount(0);
    expect(mock.pathsFor("PUT")).toHaveLength(1);
  });

  test("changes nothing when the caller is not the owner", async ({ page }) => {
    const mock = await openNamespace(page, graph(), {
      transferOwnership: { status: 403, message: "only the owner can transfer this group" },
    });
    await openPicker(page);
    await choose(page, "Bob");
    await next(page);
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(
      page.getByText("Ownership was not transferred: only the owner can transfer this group"),
    ).toBeVisible();
    await expect(page.locator(".ns-modal")).toHaveCount(0);
    expect(mock.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /admin-api/groups/${NS_ID}/transfer-ownership`,
    ]);
  });

  test("reports a refused promotion and never asks for the transfer", async ({ page }) => {
    const mock = await openNamespace(page, graph(), {
      updateMemberRole: { status: 403, message: "not allowed" },
    });
    await openPicker(page);
    await choose(page, "Bob");
    await next(page);
    await page.locator(".ns-delete-confirm-btn").click();

    await expect(page.getByText("Ownership was not transferred: not allowed")).toBeVisible();
    // The one POST is the first transfer, which found Bob not yet an admin.
    expect(mock.pathsFor("POST")).toHaveLength(1);
  });

  test("a plain member is not offered the action", async ({ page }) => {
    await openNamespace(page, graph({ role: "Member" }));

    await page.locator(".ns-actions-menu-btn").click();
    await expect(page.locator(".ns-actions-menu").getByText("Leave", { exact: true })).toBeVisible();
    await expect(page.locator(".ns-actions-menu").getByText("Transfer Ownership")).toHaveCount(0);
  });

  test("a linked device sees it disabled with the reason, and never calls the node", async ({ page }) => {
    const mock = await openNamespace(page, graph({ holdsAccountRoot: false }));

    await page.locator(".ns-actions-menu-btn").click();
    const item = page.locator(".ns-actions-menu-item", { hasText: "Transfer Ownership" });
    await expect(item).toBeDisabled();
    await expect(item).toContainText("Do this on the computer that holds the account.");
    await item.click({ force: true });

    await expect(page.locator(".ns-modal")).toHaveCount(0);
    expect(mock.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("a link to the namespace opens the picker", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph());
    await page.goto(`/?transferNamespace=${NS_ID}`);
    await waitForAppShellReady(page);

    await expect(page.locator(".ns-page-top h1")).toHaveText("Design Review");
    await expect(page.locator(".ns-modal h2")).toHaveText("Transfer Ownership");
    await expect(picker(page).locator(".ns-transfer-option")).toHaveCount(2);
  });

  test("a link opened on a linked device shows the reason and calls nothing", async ({ page }) => {
    await setupDeveloperPage(page);
    const mock = await mockNamespaceGraph(page, graph({ holdsAccountRoot: false }));
    await page.goto(`/?transferNamespace=${NS_ID}`);
    await waitForAppShellReady(page);

    await expect(picker(page)).toContainText("Do this on the computer that holds the account.");
    await expect(picker(page).locator(".ns-transfer-option")).toHaveCount(0);
    await expect(picker(page).getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(mock.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("a link opened by a plain member says only an admin can transfer", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph({ role: "Member" }));
    await page.goto(`/?transferNamespace=${NS_ID}`);
    await waitForAppShellReady(page);

    await expect(picker(page)).toContainText("Only an admin of this namespace can transfer it.");
    await expect(picker(page).locator(".ns-transfer-option")).toHaveCount(0);
  });

  test("a link to a namespace this node does not have says so", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph());
    await page.goto(`/?transferNamespace=${"9".repeat(64)}`);
    await waitForAppShellReady(page);

    await expect(page.getByText("This node does not have that namespace.")).toBeVisible();
    await expect(page.locator(".ns-modal")).toHaveCount(0);
  });

  test("a link followed from another namespace's page never offers that namespace's members", async ({ page }) => {
    await openNamespace(page, graph({ siblings: [roadmap()] }));
    await expect(page.locator(".ns-page-top h1")).toHaveText("Design Review");
    // Every row the picker ever renders, however briefly.
    await page.evaluate(() => {
      const seen: string[] = ((window as any).__offered = []);
      new MutationObserver(() => {
        document.querySelectorAll(".ns-transfer-option").forEach((o) => seen.push(o.textContent ?? ""));
      }).observe(document.body, { childList: true, subtree: true });
    });

    await followLink(page, ROADMAP_ID);

    await expect(page.locator(".ns-page-top h1")).toHaveText("Roadmap");
    await expect(picker(page).locator(".ns-transfer-option")).toHaveText([/Dave/]);
    const offered = await page.evaluate(() => (window as any).__offered as string[]);
    expect(offered.filter((t) => /Bob|Alice/.test(t))).toEqual([]);
  });

  test("a member list the node will not give says so instead of loading forever", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockNamespaceGraph(page, graph(), { listMembers: { status: 500, message: "store unavailable" } });
    await page.goto(`/?transferNamespace=${NS_ID}`);
    await waitForAppShellReady(page);

    await expect(picker(page)).toContainText("Could not load the members: 500: store unavailable");
    await expect(picker(page).getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("a link to another namespace drops a half-made choice instead of confirming it there", async ({ page }) => {
    const mock = await openNamespace(page, graph({ siblings: [roadmap()] }));
    await openPicker(page);
    await choose(page, "Alice");
    await next(page);
    await expect(page.locator(".ns-delete-msg")).toContainText("Design Review");

    await followLink(page, ROADMAP_ID);

    await expect(page.locator(".ns-page-top h1")).toHaveText("Roadmap");
    await expect(page.locator(".ns-delete-msg")).toHaveCount(0);
    await expect(picker(page).locator(".ns-transfer-option")).toHaveText([/Dave/]);
    expect(mock.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("reopening a namespace through a link never flashes a role it has not read yet", async ({ page }) => {
    await openNamespace(page, graph({ siblings: [roadmap()] }));
    await page.locator(".ns-back").click();
    await page.locator(".ns-back").click();
    await page.evaluate(() => {
      const seen: string[] = ((window as any).__modal = []);
      new MutationObserver(() => {
        document.querySelectorAll(".ns-modal").forEach((m) => seen.push(m.textContent ?? ""));
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    await followLink(page, NS_ID);

    await expect(picker(page).locator(".ns-transfer-option")).toHaveCount(2);
    const seen = await page.evaluate(() => (window as any).__modal as string[]);
    expect(seen.filter((t) => t.includes("Only an admin"))).toEqual([]);
  });

  test("a transfer that finishes after a link to another namespace leaves that picker open", async ({ page }) => {
    await openNamespace(page, graph({ siblings: [roadmap()] }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route("**/transfer-ownership", async (route) => {
      await gate;
      await route.fallback();
    });
    await openPicker(page);
    await choose(page, "Alice");
    await next(page);
    await page.locator(".ns-delete-confirm-btn").click();

    await followLink(page, ROADMAP_ID);
    await expect(picker(page).locator(".ns-transfer-option")).toHaveText([/Dave/]);
    release();

    await expect(page.getByText("Ownership transferred to Alice")).toBeVisible();
    await expect(page.locator(".ns-page-top h1")).toHaveText("Roadmap");
    await expect(picker(page).locator(".ns-transfer-option")).toHaveText([/Dave/]);
  });
});
