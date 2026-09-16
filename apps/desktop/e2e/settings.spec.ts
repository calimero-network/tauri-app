import { test, expect } from "./fixtures/test";
import type { Page } from "@playwright/test";
import {
  navigateVia,
  setupAuthenticatedPage,
  setupDeveloperPage,
  scrollSettingsControlIntoView,
} from "./fixtures/helpers";
import {
  STORAGE_KEYS,
  DEFAULT_REGISTRY_URL,
  API_ROUTES,
  MOCK_ACCOUNT_APPLICATIONS,
  MOCK_ACCOUNT_APP_ROWS,
  MOCK_ACCOUNT_DEVICES,
  MOCK_DEVICE_ALIASES,
  MOCK_APPLICATION_ID,
  MOCK_NAMESPACE_ID,
  MOCK_NAMESPACES,
  MOCK_NODE_IDENTITY,
  MOCK_OTHER_APPLICATION_ID,
  MOCK_OTHER_NAMESPACE_ID,
  MOCK_PAIR_COMPLETE,
  MOCK_PAIR_INIT,
  MOCK_PAIR_INVITE_BLOB,
  MOCK_PAIR_REPLY_BLOB,
  MOCK_RELINK,
  MOCK_REVOKE,
  listApplicationsWireBody,
} from "./fixtures/mock-data";

// ─── Navigate to Settings ──────────────────────────────────────────────────

test.describe("Settings page access", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("opens settings page via gear button, with General active and Registries reachable", async ({
    page,
  }) => {
    await page.click('button[title="Settings"]');
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toHaveText("Settings");
    await expect(
      page.locator(".settings-tab", { hasText: "General" }),
    ).toHaveClass(/active/);
    await expect(
      page.locator(".settings-tab", { hasText: "Registries" }),
    ).toBeVisible();
  });

  test("Back button returns to previous page", async ({ page }) => {
    await page.click('button[title="Settings"]');
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toHaveText("Settings");

    await page.locator("button", { hasText: "Back" }).click();
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).not.toBeVisible();
  });
});

// ─── General tab — toggles ──────────────────────────────────────────────────

test.describe("General tab toggles", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("toggles are visible, with developer mode off by default", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(page, "#theme-toggle");
    await expect(page.locator("#theme-toggle")).toBeVisible();
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).toBeVisible();
    await expect(page.locator("#developer-mode")).not.toBeChecked();
    await scrollSettingsControlIntoView(page, "#debug-logs");
    await expect(page.locator("#debug-logs")).toBeVisible();
  });

  test("toggling developer mode on updates localStorage", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").check();

    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.settings,
    );
    expect(raw).toBeTruthy();
    const settings = JSON.parse(raw!);
    expect(settings.developerMode).toBe(true);
  });

  test("toggling developer mode off updates localStorage", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").check();
    await expect(page.locator("#developer-mode")).toBeChecked();

    await page.locator("#developer-mode").uncheck();
    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.settings,
    );
    const settings = JSON.parse(raw!);
    expect(settings.developerMode).toBe(false);
  });

  test("dark mode toggle changes theme class on body", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#theme-toggle");
    const isChecked = await page.locator("#theme-toggle").isChecked();
    await page.locator("#theme-toggle").click();

    if (isChecked) {
      await expect(page.locator("body")).not.toHaveClass(/dark/);
    } else {
      await expect(page.locator("body")).toHaveClass(/dark/);
    }
  });

  test("debug logs toggle updates localStorage", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#debug-logs");
    const wasChecked = await page.locator("#debug-logs").isChecked();
    await page.locator("#debug-logs").click();

    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      STORAGE_KEYS.settings,
    );
    const settings = JSON.parse(raw!);
    expect(settings.debugLogs).toBe(!wasChecked);
  });
});

// ─── Developer mode effect on sidebar ───────────────────────────────────────

test.describe("Developer mode enables sidebar links", () => {
  test("enabling developer mode reveals Namespaces & Nodes links", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    await expect(page.locator('button[title="Namespaces"]')).not.toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).not.toBeVisible();

    await page.click('button[title="Settings"]');
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").check();

    await page.locator("button", { hasText: "Back" }).click();

    await expect(page.locator('button[title="Namespaces"]')).toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).toBeVisible();
  });

  test("disabling developer mode hides Namespaces & Nodes links", async ({
    page,
  }) => {
    await setupDeveloperPage(page);

    await expect(page.locator('button[title="Namespaces"]')).toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).toBeVisible();

    await page.click('button[title="Settings"]');
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").uncheck();

    await page.locator("button", { hasText: "Back" }).click();

    await expect(page.locator('button[title="Namespaces"]')).not.toBeVisible();
    await expect(page.locator('button[title="Nodes"]')).not.toBeVisible();
  });
});

// ─── Developer mode pre-seeded ──────────────────────────────────────────────

test.describe("Developer mode pre-seeded", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await page.click('button[title="Settings"]');
  });

  test("developer mode toggle is checked when pre-seeded", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).toBeChecked();
  });
});

// ─── Registries tab ─────────────────────────────────────────────────────────

test.describe("Registries tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
    await page.locator(".settings-tab", { hasText: "Registries" }).click();
  });

  test("Registries tab shows registry URL input and Add button", async ({
    page,
  }) => {
    await expect(page.locator("#registry-url")).toBeVisible();
    await expect(
      page.locator("button", { hasText: "Add" }),
    ).toBeVisible();
  });

  test("Add button is disabled when input is empty", async ({ page }) => {
    await expect(page.locator("#registry-url")).toHaveValue("");
    await expect(
      page.locator("button", { hasText: "Add" }),
    ).toBeDisabled();
  });

  test("Add button is enabled when input has content", async ({ page }) => {
    await page.fill("#registry-url", "https://custom-registry.example.com/");
    await expect(
      page.locator("button", { hasText: "Add" }),
    ).toBeEnabled();
  });

  test("default registry is listed", async ({ page }) => {
    await expect(page.locator(`text=${DEFAULT_REGISTRY_URL}`)).toBeVisible();
  });

  test("adding a registry updates the list", async ({ page }) => {
    const newUrl = "https://custom-registry.example.com/";
    await page.fill("#registry-url", newUrl);
    await page.locator("button", { hasText: "Add" }).click();

    await expect(page.locator(`text=${newUrl}`)).toBeVisible();
  });

  test("adding a registry clears the input", async ({ page }) => {
    await page.fill(
      "#registry-url",
      "https://custom-registry.example.com/",
    );
    await page.locator("button", { hasText: "Add" }).click();

    await expect(page.locator("#registry-url")).toHaveValue("");
  });

  test("removing a registry updates localStorage", async ({ page }) => {
    const newUrl = "https://temp-registry.example.com/";
    await page.fill("#registry-url", newUrl);
    await page.locator("button", { hasText: "Add" }).click();
    await expect(page.locator(`text=${newUrl}`)).toBeVisible();

    const removeButtons = page.locator("button", { hasText: "Remove" });
    const count = await removeButtons.count();
    await removeButtons.nth(count - 1).click();

    await expect(page.locator(`text=${newUrl}`)).not.toBeVisible();
  });
});

// ─── Reset / Nuke sections ──────────────────────────────────────────────────

test.describe("Reset and Nuke sections", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("Reset section shows its button, which reveals a confirmation checkbox", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Reset settings" }),
    );
    const resetBtn = page.locator("button", { hasText: "Reset settings" });
    await expect(resetBtn).toBeVisible();

    await resetBtn.click();
    await expect(
      page.locator("text=I understand this cannot be undone"),
    ).toBeVisible();
  });

  test("Nuke section shows its button, which reveals a confirmation checkbox", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Delete data folder and reset" }),
    );
    const nukeBtn = page.locator("button", {
      hasText: "Delete data folder and reset",
    });
    await expect(nukeBtn).toBeVisible();

    await nukeBtn.click();
    await expect(
      page.locator("text=I understand this will permanently"),
    ).toBeVisible();
  });
});

// ─── Tab switching ──────────────────────────────────────────────────────────

test.describe("Tab switching", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("switching to Registries tab and back to General preserves state", async ({
    page,
  }) => {
    await page.locator(".settings-tab", { hasText: "Registries" }).click();
    await expect(page.locator("#registry-url")).toBeVisible();
    await expect(page.locator("#developer-mode")).not.toBeVisible();

    await page.locator(".settings-tab", { hasText: "General" }).click();
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).toBeVisible();
    await expect(page.locator("#registry-url")).not.toBeVisible();
  });
});
// ─── Account page ───────────────────────────────────────────────────────────

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

test.describe("Account page", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.route(API_ROUTES.identity, (route) =>
      route.fulfill(json({ data: MOCK_NODE_IDENTITY })),
    );
    // An account with nothing on it yet, so the identity assertions below do not
    // depend on the device listing's wire shape.
    await page.route(API_ROUTES.namespaces, (route) => route.fulfill(json({ data: [] })));
    await page.route(API_ROUTES.accountDevices, (route) => route.fulfill(json({ devices: [] })));
    await navigateVia(page, "Account");
  });

  test("the page shows this device and the account's devices", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "This device" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Devices on this account" }),
    ).toBeVisible();
  });

  test("identity fields render from the node's identity", async ({ page }) => {
    await expect(page.locator("#value-account-id")).toHaveText(
      MOCK_NODE_IDENTITY.accountId,
    );
    await expect(page.locator("#value-device-id")).toHaveText(
      MOCK_NODE_IDENTITY.deviceId,
    );
    await expect(page.locator("#value-public-key")).toHaveText(
      MOCK_NODE_IDENTITY.publicKey,
    );
    await expect(page.locator("#value-account-root-public-key")).toHaveText(
      MOCK_NODE_IDENTITY.accountRootPublicKey,
    );
    await expect(page.locator("#value-account-namespace")).toHaveText(
      MOCK_NODE_IDENTITY.accountNamespaceId,
    );
    await expect(page.locator("#copy-account-id")).toBeVisible();
  });

  test("a node with no identity yet is a normal state, not an error", async ({
    page,
  }) => {
    await page.route(API_ROUTES.identity, (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "not found" }),
      }),
    );
    await page.reload();
    await navigateVia(page, "Account");

    await expect(page.locator("#account-no-identity")).toBeVisible();
    await expect(page.locator("#account-retry")).toHaveCount(0);
  });

  test("adding a device is offered on the bundled node, with no developer mode", async ({
    page,
  }) => {
    await expect(page.locator("#add-device")).toBeEnabled();
  });
});

test.describe("Settings points at the Account page", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.route(API_ROUTES.identity, (route) =>
      route.fulfill(json({ data: MOCK_NODE_IDENTITY })),
    );
    await page.route(API_ROUTES.namespaces, (route) => route.fulfill(json({ data: [] })));
    await page.route(API_ROUTES.accountDevices, (route) => route.fulfill(json({ devices: [] })));
    await page.click('button[title="Settings"]');
    await page.locator("#settings-tab-account").click();
  });

  test("the tab keeps only a link, and the link lands on the page", async ({ page }) => {
    await expect(page.locator("#add-device")).toHaveCount(0);
    await expect(page.locator("#settings-open-account")).toHaveText(
      "Manage devices on the Account page",
    );

    await page.locator("#settings-open-account").click();
    await expect(page.getByRole("heading", { name: "This device" })).toBeVisible();
    await expect(page.locator("#add-device")).toBeEnabled();
  });
});

// ─── Account page - device pairing ──────────────────────────────────────────

/** This account's two devices and namespaces, plus every account-level route. */
async function mockPairingAPIs(page: Page): Promise<void> {
  await page.route(API_ROUTES.identity, (route) =>
    route.fulfill(json({ data: MOCK_NODE_IDENTITY })),
  );
  await page.route(API_ROUTES.namespaces, (route) =>
    route.fulfill(json({ data: MOCK_NAMESPACES })),
  );
  await page.route(API_ROUTES.accountApplications, (route) =>
    route.fulfill(json({ applications: MOCK_ACCOUNT_APPLICATIONS })),
  );
  await page.route(API_ROUTES.accountDevices, (route) =>
    route.fulfill(json({ devices: MOCK_ACCOUNT_DEVICES })),
  );
  await page.route(API_ROUTES.deviceAliases, (route) =>
    route.fulfill(json({ data: MOCK_DEVICE_ALIASES })),
  );
  await page.route(API_ROUTES.createDeviceAlias, (route) => route.fulfill(json({ data: {} })));
  await page.route(API_ROUTES.deleteDeviceAlias, (route) => route.fulfill(json({ data: {} })));
  await page.route(API_ROUTES.lookupDeviceAlias, (route) =>
    route.fulfill(json({ data: { value: MOCK_PAIR_INIT.deviceId } })),
  );
  await page.route(API_ROUTES.relinkDevice, (route) =>
    route.fulfill(json({ data: MOCK_RELINK })),
  );
  await page.route(API_ROUTES.revokeDevice, (route) =>
    route.fulfill(json({ data: MOCK_REVOKE })),
  );
  await page.route(API_ROUTES.pairInit, (route) =>
    route.fulfill(json({ data: MOCK_PAIR_INIT })),
  );
  await page.route(API_ROUTES.pairComplete, (route) =>
    route.fulfill(json({ data: MOCK_PAIR_COMPLETE })),
  );
}

/** What an invite blob on screen actually carries, past its base64. */
async function inviteBodyOnScreen(page: Page): Promise<Record<string, unknown>> {
  const blob = (await page.locator("#pair-invite").innerText()).trim();
  return JSON.parse(atob(blob.replace("mero-pair:", "")));
}

async function inviteNamespacesOnScreen(page: Page): Promise<string[]> {
  return (await inviteBodyOnScreen(page)).namespaces as string[];
}

test.describe("Account page - pairing needs no developer mode", () => {
  test("both halves of the exchange are offered on an ordinary session", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);
    await mockPairingAPIs(page);
    await navigateVia(page, "Account");

    await expect(page.locator("#add-device")).toBeEnabled();
    await expect(page.locator("#pair-invite-input")).toBeVisible();
  });
});

test.describe("Account page - device listing", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await mockPairingAPIs(page);
    await navigateVia(page, "Account");
  });

  test("one row per device, with its scope and its status", async ({ page }) => {
    const rows = page.locator(".account-device-row");
    await expect(rows).toHaveCount(2);

    // This node's own device: no application scope at all, which is every app.
    await expect(rows.nth(0)).toContainText("All apps");
    await expect(rows.nth(0)).toContainText("This device");
    await expect(rows.nth(1)).toContainText("1 app");
    await expect(rows.nth(1)).toContainText("Active");
  });

  test("a named device is titled by its name, and keeps its id in the meta line", async ({
    page,
  }) => {
    const rows = page.locator(".account-device-row");

    await expect(rows.nth(1).locator(".account-device-name")).toContainText("Alice's iPad");
    await expect(rows.nth(1).locator(".account-device-meta")).toContainText(
      MOCK_PAIR_INIT.deviceId.slice(0, 8),
    );
    // Nothing named this node's own device, so its title is the short id as before.
    await expect(rows.nth(0).locator(".account-device-name")).toContainText(
      MOCK_NODE_IDENTITY.deviceId.slice(0, 8),
    );
  });

  test("a row expands into the apps it may act for and the namespaces it follows", async ({
    page,
  }) => {
    const row = page.locator(`#device-row-${MOCK_PAIR_INIT.deviceId}`);
    await expect(row.locator(".account-device-body")).toHaveCount(0);

    await page.locator(`#device-expand-${MOCK_PAIR_INIT.deviceId}`).click();

    await expect(row).toContainText("Apps this device may act for");
    await expect(row).toContainText("1 of 2 apps");
    // Personal is this device's own app; Files is the one its scope leaves out.
    await expect(row.locator(".account-ns-row").nth(0)).toContainText("Following");
    await expect(row.locator(".account-ns-row").nth(1)).toContainText("Not in scope");
  });

  test("widening a scoped device relinks it with the app it was missing", async ({
    page,
  }) => {
    const bodies: string[] = [];
    await page.route(API_ROUTES.relinkDevice, (route) => {
      bodies.push(route.request().postData() ?? "");
      return route.fulfill(json({ data: MOCK_RELINK }));
    });

    await page.locator(`#device-expand-${MOCK_PAIR_INIT.deviceId}`).click();
    await page
      .locator(`#device-app-${MOCK_PAIR_INIT.deviceId}-${MOCK_OTHER_APPLICATION_ID}`)
      .click();

    await expect(page.locator(`#device-note-${MOCK_PAIR_INIT.deviceId}`)).toHaveText(
      "Added 1 app, reaching 1 more namespace.",
    );
    expect(JSON.parse(bodies[0]).applications).toEqual([
      MOCK_APPLICATION_ID,
      MOCK_OTHER_APPLICATION_ID,
    ]);
    // The listing still shows the old scope, so the row says so until it catches up.
    await expect(
      page.locator(`#device-row-${MOCK_PAIR_INIT.deviceId} .account-status`).first(),
    ).toHaveText("Syncing");
  });

  test("the toggle of an app already in scope is locked, and says why", async ({
    page,
  }) => {
    await page.locator(`#device-expand-${MOCK_PAIR_INIT.deviceId}`).click();
    const held = page.locator(
      `#device-app-${MOCK_PAIR_INIT.deviceId}-${MOCK_APPLICATION_ID}`,
    );

    await expect(held).toBeDisabled();
    await expect(held).toHaveAttribute("title", "Narrowing a scope needs a fresh pairing");
  });

  test("every toggle of a device that follows everything is locked on", async ({
    page,
  }) => {
    await page.locator(`#device-expand-${MOCK_NODE_IDENTITY.deviceId}`).click();
    const toggle = page.locator(
      `#device-app-${MOCK_NODE_IDENTITY.deviceId}-${MOCK_APPLICATION_ID}`,
    );

    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveAttribute(
      "title",
      "This device follows everything, including apps added later",
    );
  });

  test("this device is offered neither a sync nor a revoke", async ({ page }) => {
    await expect(
      page.locator(`#device-sync-${MOCK_NODE_IDENTITY.deviceId}`),
    ).toHaveCount(0);
    await expect(
      page.locator(`#device-revoke-${MOCK_NODE_IDENTITY.deviceId}`),
    ).toHaveCount(0);
  });

  test("syncing a device reports what it repaired and what it skipped", async ({
    page,
  }) => {
    await page.locator(`#device-sync-${MOCK_PAIR_INIT.deviceId}`).click();

    await expect(page.locator(`#device-note-${MOCK_PAIR_INIT.deviceId}`)).toHaveText(
      "Repaired 1 namespace, skipped 1.",
    );
  });

  test("revoking asks in the row itself and can be backed out of", async ({
    page,
  }) => {
    await page.locator(`#device-revoke-${MOCK_PAIR_INIT.deviceId}`).click();
    await expect(
      page.locator(`#device-revoke-confirm-${MOCK_PAIR_INIT.deviceId}`),
    ).toBeVisible();

    await page.locator(`#device-revoke-cancel-${MOCK_PAIR_INIT.deviceId}`).click();
    await expect(
      page.locator(`#device-revoke-confirm-${MOCK_PAIR_INIT.deviceId}`),
    ).toHaveCount(0);
    await expect(page.locator(`#device-note-${MOCK_PAIR_INIT.deviceId}`)).toHaveCount(0);
  });

  test("confirming the revoke names the namespaces the device lost", async ({
    page,
  }) => {
    await page.locator(`#device-revoke-${MOCK_PAIR_INIT.deviceId}`).click();
    await page.locator(`#device-revoke-confirm-${MOCK_PAIR_INIT.deviceId}`).click();

    await expect(page.locator(`#device-note-${MOCK_PAIR_INIT.deviceId}`)).toHaveText(
      "Withdrawn from 1 namespace.",
    );
  });
});

test.describe("Account page - a device the account is held away from", () => {
  /** The same account seen from a paired device: it holds no root of its own. */
  async function mockHeldElsewhere(
    page: Page,
    identity: Record<string, unknown> = {},
    devices = MOCK_ACCOUNT_DEVICES,
  ): Promise<void> {
    await mockPairingAPIs(page);
    await page.route(API_ROUTES.identity, (route) =>
      route.fulfill(
        json({ data: { ...MOCK_NODE_IDENTITY, holdsAccountRoot: false, ...identity } }),
      ),
    );
    await page.route(API_ROUTES.accountDevices, (route) =>
      route.fulfill(json({ devices })),
    );
    await navigateVia(page, "Account");
  }

  test("it may look but not invite, hand out a link code or revoke", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockHeldElsewhere(page);

    await expect(page.locator(".account-device-row")).toHaveCount(2);
    await expect(page.locator("#add-device")).toHaveCount(0);
    await expect(page.locator("#link-code-show")).toHaveCount(0);
    await expect(page.locator(`#device-revoke-${MOCK_PAIR_INIT.deviceId}`)).toHaveCount(0);
  });

  test("sync is offered on its own row and on no other", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockHeldElsewhere(page);

    await expect(page.locator(`#device-sync-${MOCK_NODE_IDENTITY.deviceId}`)).toBeEnabled();
    await expect(page.locator(`#device-sync-${MOCK_PAIR_INIT.deviceId}`)).toHaveCount(0);
  });

  test("every toggle names the computer that can change a scope", async ({ page }) => {
    await setupDeveloperPage(page);
    await mockHeldElsewhere(page);
    await page.locator(`#device-expand-${MOCK_PAIR_INIT.deviceId}`).click();
    const toggle = page.locator(
      `#device-app-${MOCK_PAIR_INIT.deviceId}-${MOCK_OTHER_APPLICATION_ID}`,
    );

    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute(
      "title",
      "Only the computer holding the account root can change scope",
    );
  });

  test("a withdrawn device says so in red before anything else on the card", async ({
    page,
  }) => {
    await setupDeveloperPage(page);
    await mockHeldElsewhere(page, {}, [
      { ...MOCK_ACCOUNT_DEVICES[0], revoked: true },
      MOCK_ACCOUNT_DEVICES[1],
    ]);

    await expect(page.locator("#account-banner-revoked")).toContainText(
      "can no longer write",
    );
  });

  test("a device paired by an older version is pointed at the link code", async ({
    page,
  }) => {
    await setupDeveloperPage(page);
    await mockHeldElsewhere(page, { accountNamespaceId: null });

    await expect(page.locator("#account-banner-legacy")).toContainText(
      "does not follow the account yet",
    );
    // The banner points at the paste field, so the field has to still be there.
    await expect(page.locator("#pair-invite-input")).toBeVisible();
  });
});

test.describe("Account page - apps on this account", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await mockPairingAPIs(page);
    await page.route(API_ROUTES.listApplications, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: listApplicationsWireBody(MOCK_ACCOUNT_APP_ROWS),
      }),
    );
    await navigateVia(page, "Account");
  });

  test("every app a namespace targets is listed, with what reaches it", async ({
    page,
  }) => {
    const rows = page.locator("#account-apps .account-app-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Mero Chat" })).toContainText(
      "mero-chat · 1 namespace · 2 devices in scope",
    );
    await expect(
      page.locator(`#app-installed-${MOCK_APPLICATION_ID}`),
    ).toContainText("Installed");
  });

  test("an app this node has no blob for is offered for install", async ({ page }) => {
    const bodies: string[] = [];
    await page.route(API_ROUTES.installApplication, (route) => {
      bodies.push(route.request().postData() ?? "");
      return route.fulfill(json({ data: { applicationId: MOCK_OTHER_APPLICATION_ID } }));
    });

    await page.locator(`#app-install-${MOCK_OTHER_APPLICATION_ID}`).click();

    await expect
      .poll(() => bodies.length)
      .toBeGreaterThan(0);
    expect(JSON.parse(bodies[0])).toEqual({ package: "mero-drive", version: "2.0.0" });
  });
});

test.describe("Account page - pairing wizard", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await mockPairingAPIs(page);
    await navigateVia(page, "Account");
    await page.locator("#add-device").click();
  });

  test("the invite step opens on everything, with no tiles in the way", async ({
    page,
  }) => {
    await expect(page.getByRole("heading", { name: "1. Show the invite" })).toBeVisible();
    await expect(page.locator("#pair-scope-all")).toBeChecked();
    await expect(page.locator("#pair-app-list")).toHaveCount(0);
    await expect(page.locator("#pair-next")).toBeEnabled();
  });

  test("everything hands the new device every namespace", async ({ page }) => {
    // Decoded, not matched as text: the ids are inside base64, where a substring
    // assertion would pass on a blob that names the wrong set.
    expect(await inviteNamespacesOnScreen(page)).toEqual([
      MOCK_NAMESPACE_ID,
      MOCK_OTHER_NAMESPACE_ID,
    ]);
  });

  test("ticking one tile narrows the invite to that app's namespaces", async ({
    page,
  }) => {
    await page.locator("#pair-scope-apps").check();
    await page.locator(`#pair-app-${MOCK_OTHER_APPLICATION_ID}`).click();

    await expect(
      page.locator(`#pair-app-${MOCK_OTHER_APPLICATION_ID}`),
    ).toHaveAttribute("aria-pressed", "true");
    expect(await inviteNamespacesOnScreen(page)).toEqual([MOCK_OTHER_NAMESPACE_ID]);
  });

  test("a tile names the app and what picking it would cover", async ({ page }) => {
    await page.locator("#pair-scope-apps").check();

    await expect(page.locator("#pair-app-list")).toContainText("Personal");
    await expect(page.locator("#pair-app-list")).toContainText("Files");
    await expect(page.locator("#pair-app-list")).toContainText("1 namespace");
    await expect(page.locator("#pair-app-list")).not.toContainText(
      MOCK_APPLICATION_ID,
    );
  });

  test("ticking nothing under the narrowed scope holds the step", async ({ page }) => {
    await page.locator("#pair-scope-apps").check();

    await expect(page.locator("#pair-next")).toBeDisabled();
  });

  test("the invite blob names this account's namespace", async ({
    page,
  }) => {
    await expect(page.locator("#pair-invite")).toContainText("mero-pair:");
    await expect(page.locator("#copy-pair-invite")).toBeVisible();
    expect(await inviteBodyOnScreen(page)).toMatchObject({
      accountNamespace: MOCK_NODE_IDENTITY.accountNamespaceId,
    });
  });

  test("the wizard opens on an account with no namespace yet", async ({ page }) => {
    await page.route(API_ROUTES.namespaces, (route) => route.fulfill(json({ data: [] })));
    await page.route(API_ROUTES.accountApplications, (route) =>
      route.fulfill(json({ applications: [] })),
    );
    await page.reload();
    await navigateVia(page, "Account");
    await page.locator("#add-device").click();

    await expect(page.locator("#pair-no-namespace")).toHaveCount(0);
    await expect(page.locator("#pair-invite")).toContainText("mero-pair:");
  });

  test("pair-complete carries the apps the tiles chose", async ({ page }) => {
    const bodies: string[] = [];
    await page.route(API_ROUTES.pairComplete, (route) => {
      bodies.push(route.request().postData() ?? "");
      return route.fulfill(json({ data: MOCK_PAIR_COMPLETE }));
    });

    await page.locator("#pair-scope-apps").check();
    await page.locator(`#pair-app-${MOCK_OTHER_APPLICATION_ID}`).click();
    await page.locator("#pair-next").click();
    await page.fill("#pair-response", MOCK_PAIR_REPLY_BLOB);
    await page.fill("#pair-code", MOCK_PAIR_INIT.confirmationCode);
    await page.locator("#pair-complete").click();

    await expect(page.locator("#pair-success")).toBeVisible();
    expect(JSON.parse(bodies[0]).applications).toEqual([MOCK_OTHER_APPLICATION_ID]);
  });

  test("a name typed on the confirm step is stored against the device", async ({
    page,
  }) => {
    const bodies: string[] = [];
    await page.route(API_ROUTES.createDeviceAlias, (route) => {
      bodies.push(route.request().postData() ?? "");
      return route.fulfill(json({ data: {} }));
    });

    await page.locator("#pair-next").click();
    await page.fill("#pair-response", MOCK_PAIR_REPLY_BLOB);
    await page.fill("#pair-code", MOCK_PAIR_INIT.confirmationCode);
    await page.fill("#pair-name", "  Alice's iPhone  ");
    await page.locator("#pair-complete").click();

    await expect(page.locator("#pair-success")).toBeVisible();
    expect(JSON.parse(bodies[0])).toEqual({
      alias: "Alice's iPhone",
      deviceId: MOCK_PAIR_INIT.deviceId,
    });
  });

  test("leaving the name empty names nothing", async ({ page }) => {
    let named = 0;
    await page.route(API_ROUTES.createDeviceAlias, (route) => {
      named += 1;
      return route.fulfill(json({ data: {} }));
    });

    await page.locator("#pair-next").click();
    await page.fill("#pair-response", MOCK_PAIR_REPLY_BLOB);
    await page.fill("#pair-code", MOCK_PAIR_INIT.confirmationCode);
    await page.locator("#pair-complete").click();

    await expect(page.locator("#pair-success")).toBeVisible();
    expect(named).toBe(0);
  });

  test("a name the node refuses is said out loud, and the device stays added", async ({
    page,
  }) => {
    await page.route(API_ROUTES.createDeviceAlias, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "alias contains an invalid character" }),
      }),
    );

    await page.locator("#pair-next").click();
    await page.fill("#pair-response", MOCK_PAIR_REPLY_BLOB);
    await page.fill("#pair-code", MOCK_PAIR_INIT.confirmationCode);
    await page.fill("#pair-name", "Alice/iPhone");
    await page.locator("#pair-complete").click();

    await expect(page.locator("#pair-success")).toBeVisible();
    await expect(page.locator("#pair-name-error")).toHaveText(
      "alias contains an invalid character",
    );
  });

  test("the confirm step takes the reply and the code in separate fields", async ({
    page,
  }) => {
    await page.locator("#pair-next").click();

    await expect(page.getByRole("heading", { name: "2. Confirm the device" })).toBeVisible();

    await expect(page.locator("#pair-response")).toBeVisible();
    await expect(page.locator("#pair-code")).toBeVisible();
    await expect(page.locator("#pair-complete")).toBeDisabled();

    // A response alone is not enough: the code is read off the other screen,
    // never carried by the blob.
    await page.fill("#pair-response", MOCK_PAIR_REPLY_BLOB);
    expect(MOCK_PAIR_REPLY_BLOB).not.toContain(MOCK_PAIR_INIT.confirmationCode);
    await expect(page.locator("#pair-invalid")).toContainText("confirmationCode");
    await expect(page.locator("#pair-complete")).toBeDisabled();

    await page.fill("#pair-code", MOCK_PAIR_INIT.confirmationCode);
    await expect(page.locator("#pair-invalid")).toHaveCount(0);
    await expect(page.locator("#pair-complete")).toBeEnabled();
  });

  test("a truncated response is named as such before it is sent", async ({
    page,
  }) => {
    await page.locator("#pair-next").click();
    await page.fill("#pair-response", "mero-pair-reply:" + btoa('{"deviceId":"abc"}'));

    await expect(page.locator("#pair-invalid")).toContainText(
      "deviceId must be 64 hex characters",
    );
    await expect(page.locator("#pair-complete")).toBeDisabled();
  });

  test("linking shows a loader and then the success state", async ({ page }) => {
    await page.locator("#pair-next").click();
    await page.fill("#pair-response", MOCK_PAIR_REPLY_BLOB);
    await page.fill("#pair-code", MOCK_PAIR_INIT.confirmationCode);
    await page.locator("#pair-complete").click();

    await expect(page.locator("#pair-linking")).toBeVisible();
    await expect(page.locator("#pair-success")).toBeVisible();
    // The listing already has the device, so it converged - no syncing note.
    await expect(page.locator("#pair-syncing-note")).toHaveCount(0);
  });
});

test.describe("Account page - pairing responder", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await mockPairingAPIs(page);
    await navigateVia(page, "Account");
  });

  test("an invite yields a response blob and a spoken confirmation code", async ({
    page,
  }) => {
    const initBodies: string[] = [];
    await page.route(API_ROUTES.pairInit, (route) => {
      initBodies.push(route.request().postData() ?? "");
      return route.fulfill(json({ data: MOCK_PAIR_INIT }));
    });

    await page.fill("#pair-invite-input", MOCK_PAIR_INVITE_BLOB);
    await page.locator("#pair-init").click();

    await expect(page.locator("#pair-reply")).toContainText("mero-pair-reply:");
    expect(JSON.parse(initBodies[0]).accountNamespace).toBe(
      MOCK_NODE_IDENTITY.accountNamespaceId,
    );

    await expect(page.locator("#pair-reply")).toContainText("mero-pair-reply:");

    // Decoded, not searched: the code would not appear in the base64 text even
    // if the blob carried it, so a text assertion here would prove nothing. Read
    // on this step, which is the only one that shows the blob.
    const blob = (await page.locator("#pair-reply").innerText()).trim();
    const body = JSON.parse(atob(blob.replace("mero-pair-reply:", "")));
    expect(Object.keys(body).sort()).toEqual([
      "deviceId",
      "kemPublicKey",
      "signPublicKey",
      "statement",
    ]);

    await page.locator("#pair-answer-next").click();
    await expect(page.locator("#pair-confirmation-code")).toHaveText(
      MOCK_PAIR_INIT.confirmationCode,
    );
  });

  test("it waits while the account roster has not reached this device", async ({ page }) => {
    // Empty is what a real node returns between `pair-init` and `pair-complete`.
    await page.route(API_ROUTES.accountDevices, (route) => route.fulfill(json({ devices: [] })));

    await page.fill("#pair-invite-input", MOCK_PAIR_INVITE_BLOB);
    await page.locator("#pair-init").click();
    await page.locator("#pair-answer-next").click();

    await expect(page.locator("#pair-link-state")).toContainText("Waiting for the other computer");
    await expect(page.locator("#pair-link-state")).toHaveClass(/is-waiting/);
  });

  test("nothing installs while it is still waiting", async ({ page }) => {
    await page.route(API_ROUTES.accountDevices, (route) => route.fulfill(json({ devices: [] })));
    let installs = 0;
    await page.route(API_ROUTES.installApplication, (route) => {
      installs += 1;
      return route.fulfill(json({ data: { applicationId: "a".repeat(64) } }));
    });

    await page.fill("#pair-invite-input", MOCK_PAIR_INVITE_BLOB);
    await page.locator("#pair-init").click();
    await page.locator("#pair-answer-next").click();
    await expect(page.locator("#pair-app-installs")).toBeVisible();

    await page.waitForTimeout(4000);
    expect(installs).toBe(0);
  });

  test("it links and installs once the roster names this device", async ({ page }) => {
    await page.route(API_ROUTES.installApplication, (route) =>
      route.fulfill(json({ data: { applicationId: "a".repeat(64) } })),
    );

    // The mocked listing already carries an `isSelf` row, which is the state a
    // node reaches only after `pair-complete` publishes the certificate.
    await page.fill("#pair-invite-input", MOCK_PAIR_INVITE_BLOB);
    await page.locator("#pair-init").click();
    await page.locator("#pair-answer-next").click();

    await expect(page.locator("#pair-link-state")).toContainText("Linked");
    await expect(page.locator("#pair-app-installs")).toContainText("installed");
  });

  test("closing the answer discards it rather than hiding it", async ({ page }) => {
    await page.fill("#pair-invite-input", MOCK_PAIR_INVITE_BLOB);
    await page.locator("#pair-init").click();
    await page.locator("#pair-answer-next").click();
    await expect(page.locator("#pair-confirmation-code")).toBeVisible();

    await page.locator("#pair-answer-close").click();

    // Dropped, not concealed: a stale code left on screen is one somebody reads
    // out for a pairing that is no longer in flight.
    await expect(page.locator("#pair-confirmation-code")).toHaveCount(0);
    await expect(page.locator("#pair-reply")).toHaveCount(0);
    await expect(page.locator("#pair-app-installs")).toHaveCount(0);
  });

  test("an invite naming no namespace is not one", async ({ page }) => {
    const empty =
      "mero-pair:" +
      btoa(JSON.stringify({ rootKey: MOCK_NODE_IDENTITY.accountRootPublicKey, namespaces: [] }));
    await page.fill("#pair-invite-input", empty);

    await expect(page.locator("#pair-invite-invalid")).toBeVisible();
    await expect(page.locator("#pair-init")).toBeDisabled();
  });

  test("a node that already has an identity is warned before it pairs", async ({
    page,
  }) => {
    await expect(page.locator("#pair-already-enrolled")).toBeVisible();
  });
});

test.describe("Settings toasts render", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  // Settings short-circuits the page shells that mount every other
  // ToastContainer, so without its own mount these fire into a void.
  test("a toast fired from Settings is visible", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await page.locator("#developer-mode").check();

    await expect(page.locator(".toast-container .toast")).toBeVisible();
    await expect(page.locator(".toast-message")).toHaveText(
      "Developer mode enabled",
    );
  });
});
