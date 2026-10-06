import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures/test";
import {
  navigateVia,
  seedAuthTokens,
  seedSettings,
  setupSimpleModePage,
  mockCoreAPIs,
  waitForAppShellReady,
} from "./fixtures/helpers";
import { SIMPLE_MODE_SETTINGS, type AppSettings } from "./fixtures/mock-data";

/**
 * The Cloud page: High Availability for every namespace, grouped by
 * application, one click from the sidebar. It used to be a section at the
 * bottom of a namespace's detail view, three levels into a page only
 * Developer Mode shows.
 */

const CLOUD_API = "https://manager.cloud.calimero.network";
const MY_ACCOUNT = "1".repeat(64);
const OTHER_ACCOUNT = "2".repeat(64);

const NS_DESIGN = "a".repeat(64);
const NS_TRIP = "b".repeat(64);
const NS_BOARD = "c".repeat(64);

const NAMESPACES = [
  { namespaceId: NS_DESIGN, targetApplicationId: "installed-app-1", name: "Design team", memberCount: 8 },
  { namespaceId: NS_TRIP, targetApplicationId: "installed-app-1", name: "Weekend trip", memberCount: 4 },
  // Someone else administers this one: listed, but locked.
  { namespaceId: NS_BOARD, targetApplicationId: "installed-app-2", name: "Board notes", memberCount: 5 },
].map((n) => ({ ...n, bytecodeId: "bytecode", createdAt: 0, contextCount: 0, subgroupCount: 0 }));

const ADMIN_OF = new Set([NS_DESIGN, NS_TRIP]);

/** An MDMA session token: `iss: "mdma"`, an email, and an hour left. */
function mdmaToken(): string {
  const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ iss: "mdma", email: "alex@example.com", exp })}.sig`;
}

async function setupCloudPage(page: Page, settings: Partial<AppSettings>) {
  await mockCoreAPIs(page);
  await page.route("**/admin-api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path.endsWith("/admin-api/identity")) {
      return json({ data: { accountId: MY_ACCOUNT, deviceId: "dev-1", publicKey: "pk-1" } });
    }
    if (path.endsWith("/admin-api/namespaces")) return json({ data: NAMESPACES });
    const members = path.match(/\/admin-api\/groups\/([^/]+)\/members$/);
    if (members) {
      const rows = [{ identity: OTHER_ACCOUNT, role: "Admin" }];
      if (ADMIN_OF.has(members[1])) rows.push({ identity: MY_ACCOUNT, role: "Admin" });
      else rows.push({ identity: MY_ACCOUNT, role: "Member" });
      return json({ members: rows });
    }
    return route.fallback();
  });

  const disabled: string[] = [];
  await page.route(`${CLOUD_API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/cloud/me/subscription") return json({ plan: "pro", status: "active", current_period_end: null });
    if (path === "/api/cloud/me/namespaces") {
      return json([
        { namespace_id: NS_DESIGN, contexts: [], ha_status: "enabled", ha_enabled_at: null, fleet_replicas: { active: 2, assigned: 2, limit: 3 } },
        { namespace_id: NS_BOARD, contexts: [], ha_status: "enabled", ha_enabled_at: null, fleet_replicas: { active: 1, assigned: 1, limit: 3 } },
      ]);
    }
    // Empty measurements make the policy reconcile a no-op.
    if (path === "/api/cloud/fleet/measurements") {
      return json({ allowed_mrtd: [], allowed_rtmr0: [], allowed_rtmr1: [], allowed_rtmr2: [], allowed_rtmr3: [], release_tag: "" });
    }
    const disable = path.match(/^\/api\/cloud\/me\/namespaces\/([^/]+)\/disable-ha$/);
    if (disable) {
      disabled.push(disable[1]);
      return json({});
    }
    return route.fulfill({ status: 404, body: "" });
  });

  await page.goto("/");
  await seedSettings(page, { ...SIMPLE_MODE_SETTINGS, ...settings });
  await seedAuthTokens(page);
  await page.evaluate(() => localStorage.setItem("calimero-autostart-default-applied", "1"));
  await page.reload();
  await waitForAppShellReady(page);
  await navigateVia(page, "Cloud");
  return { disabled };
}

const SIGNED_IN: Partial<AppSettings> = {
  cloudConnected: true,
  cloudIdToken: mdmaToken(),
  cloudUserEmail: "alex@example.com",
  cloudUserName: "Alex Rivera",
};

test.describe("Cloud – in the sidebar", () => {
  test("is listed without Developer Mode", async ({ page }) => {
    await setupSimpleModePage(page);
    await expect(page.locator("aside.sidebar").getByTitle("Cloud")).toBeVisible();
  });

  test("is hidden when Calimero Cloud is switched off", async ({ page }) => {
    await mockCoreAPIs(page);
    await page.goto("/");
    await seedSettings(page, { ...SIMPLE_MODE_SETTINGS, cloudEnabled: false });
    await seedAuthTokens(page);
    await page.reload();
    await waitForAppShellReady(page);
    await expect(page.locator("aside.sidebar").getByTitle("Cloud")).toHaveCount(0);
  });
});

test.describe("Cloud – signed out", () => {
  test("offers sign-in instead of the namespace list", async ({ page }) => {
    await setupCloudPage(page, {});
    await expect(page.getByTestId("shell-page-title")).toHaveText("Cloud");
    await expect(page.getByRole("heading", { name: "Connect Calimero Cloud" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in to Calimero Cloud" })).toBeVisible();
    await expect(page.getByTestId("cloud-app")).toHaveCount(0);
    await expect(page.locator(".nav-status-signed-out")).toBeVisible();
  });
});

test.describe("Cloud – signed in", () => {
  test("groups namespaces under their application with HA state", async ({ page }) => {
    await setupCloudPage(page, SIGNED_IN);

    await expect(page.locator(".cloud-account-name")).toHaveText("Alex Rivera");
    await expect(page.locator(".cloud-pill-plan")).toHaveText("pro plan");
    await expect(page.locator(".nav-status-connected")).toBeVisible();

    const apps = page.getByTestId("cloud-app");
    await expect(apps).toHaveCount(2);
    const chat = apps.filter({ hasText: "Only Peers Chat" });
    await expect(chat.locator(".cloud-app-meter")).toContainText("1 of 2 always on");
    await expect(chat.getByRole("button", { name: "Turn on", exact: true })).toBeVisible();

    const design = page.locator(`[data-namespace-id="${NS_DESIGN}"]`);
    await expect(design.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await expect(design.locator(".cloud-pill")).toContainText("Always on");
    const trip = page.locator(`[data-namespace-id="${NS_TRIP}"]`);
    await expect(trip.getByRole("switch")).toHaveAttribute("aria-checked", "false");

    // Administered by someone else: status shown, no switch.
    const board = page.locator(`[data-namespace-id="${NS_BOARD}"]`);
    await expect(board.locator(".cloud-pill")).toContainText("Always on");
    await expect(board.getByRole("switch")).toHaveCount(0);
    await expect(board.locator(".cloud-ns-lock")).toHaveAttribute("title", /Only the namespace admin/);

    await expect(page.locator(".cloud-stat-accent")).toContainText("1 of 2");
  });

  test("filters to namespaces shared with me, and by search", async ({ page }) => {
    await setupCloudPage(page, SIGNED_IN);
    await expect(page.getByTestId("cloud-ns-row")).toHaveCount(3);

    await page.getByRole("button", { name: "Shared with me" }).click();
    await expect(page.getByTestId("cloud-ns-row")).toHaveCount(1);
    await expect(page.getByTestId("cloud-ns-row")).toContainText("Board notes");

    await page.getByRole("button", { name: "All" }).click();
    await page.locator("#cloud-search").fill("weekend");
    await expect(page.getByTestId("cloud-ns-row")).toHaveCount(1);
    await expect(page.getByTestId("cloud-ns-row")).toContainText("Weekend trip");
  });

  test("collapses an application", async ({ page }) => {
    await setupCloudPage(page, SIGNED_IN);
    const chat = page.getByTestId("cloud-app").filter({ hasText: "Only Peers Chat" });
    await expect(chat.getByTestId("cloud-ns-row")).toHaveCount(2);
    await chat.locator(".cloud-app-header").click();
    await expect(chat.getByTestId("cloud-ns-row")).toHaveCount(0);
  });

  test("asks before turning HA off, then turns it off", async ({ page }) => {
    const { disabled } = await setupCloudPage(page, SIGNED_IN);
    const design = page.locator(`[data-namespace-id="${NS_DESIGN}"]`);

    await design.getByRole("switch").click();
    await expect(design.locator(".cloud-ns-confirm")).toContainText("Fleet nodes will leave");
    await design.getByRole("button", { name: "Cancel" }).click();
    await expect(design.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(disabled).toEqual([]);

    await design.getByRole("switch").click();
    await design.getByRole("button", { name: "Turn off" }).click();
    await expect(design.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(disabled).toEqual([NS_DESIGN]);
  });
});
