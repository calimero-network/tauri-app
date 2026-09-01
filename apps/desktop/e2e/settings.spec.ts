import { test, expect } from "./fixtures/test";
import { describeAfter35 } from "./fixtures/e2e-cap";
import type { Page } from "@playwright/test";
import {
  setupAuthenticatedPage,
  setupDeveloperPage,
  seedSettings,
  seedAuthTokens,
  mockCoreAPIs,
  scrollSettingsControlIntoView,
} from "./fixtures/helpers";
import {
  STORAGE_KEYS,
  AUTHENTICATED_SETTINGS,
  DEVELOPER_SETTINGS,
  DEFAULT_REGISTRY_URL,
  API_ROUTES,
  MOCK_ACCOUNT_APPLICATIONS,
  MOCK_ACCOUNT_DEVICES,
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
} from "./fixtures/mock-data";

// ─── Navigate to Settings ──────────────────────────────────────────────────

describeAfter35("Settings page access", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
  });

  test("opens settings page via gear button", async ({ page }) => {
    await page.click('button[title="Settings"]');
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toHaveText("Settings");
  });

  test("settings page has General tab active by default", async ({ page }) => {
    await page.click('button[title="Settings"]');
    const generalTab = page.locator(".settings-tab", { hasText: "General" });
    await expect(generalTab).toHaveClass(/active/);
  });

  test("settings page has Registries tab", async ({ page }) => {
    await page.click('button[title="Settings"]');
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

describeAfter35("General tab toggles", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("dark mode toggle is visible", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#theme-toggle");
    await expect(page.locator("#theme-toggle")).toBeVisible();
  });

  test("developer mode toggle is visible", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).toBeVisible();
  });

  test("debug logs toggle is visible", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#debug-logs");
    await expect(page.locator("#debug-logs")).toBeVisible();
  });

  test("developer mode is off by default", async ({ page }) => {
    await scrollSettingsControlIntoView(page, "#developer-mode");
    await expect(page.locator("#developer-mode")).not.toBeChecked();
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

describeAfter35("Developer mode enables sidebar links", () => {
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

describeAfter35("Developer mode pre-seeded", () => {
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

describeAfter35("Registries tab", () => {
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

describeAfter35("Reset and Nuke sections", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.click('button[title="Settings"]');
  });

  test("Reset section shows initial button", async ({ page }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Reset settings" }),
    );
    await expect(
      page.locator("button", { hasText: "Reset settings" }),
    ).toBeVisible();
  });

  test("clicking Reset button shows confirmation checkbox", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Reset settings" }),
    );
    await page
      .locator("button", { hasText: "Reset settings" })
      .click();
    await expect(
      page.locator("text=I understand this cannot be undone"),
    ).toBeVisible();
  });

  test("Nuke section shows initial button", async ({ page }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Delete data folder and reset" }),
    );
    await expect(
      page.locator("button", { hasText: "Delete data folder and reset" }),
    ).toBeVisible();
  });

  test("clicking Nuke button shows confirmation checkbox", async ({
    page,
  }) => {
    await scrollSettingsControlIntoView(
      page,
      page.getByRole("button", { name: "Delete data folder and reset" }),
    );
    await page
      .locator("button", { hasText: "Delete data folder and reset" })
      .click();
    await expect(
      page.locator("text=I understand this will permanently"),
    ).toBeVisible();
  });
});

// ─── Tab switching ──────────────────────────────────────────────────────────

describeAfter35("Tab switching", () => {
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
// ─── Account tab ────────────────────────────────────────────────────────────

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

describeAfter35("Account tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupAuthenticatedPage(page);
    await page.route(API_ROUTES.identity, (route) =>
      route.fulfill(json({ data: MOCK_NODE_IDENTITY })),
    );
    // An account with nothing on it yet, so the identity assertions below do not
    // depend on the device listing's wire shape.
    await page.route(API_ROUTES.namespaces, (route) => route.fulfill(json({ data: [] })));
    await page.route(API_ROUTES.accountDevices, (route) => route.fulfill(json({ devices: [] })));
    await page.click('button[title="Settings"]');
  });

  test("Account tab is visible", async ({ page }) => {
    await expect(page.locator("#settings-tab-account")).toBeVisible();
  });

  test("clicking the Account tab shows the panel", async ({ page }) => {
    await page.locator("#settings-tab-account").click();
    await expect(
      page.getByRole("heading", { name: "This device" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Devices on this account" }),
    ).toBeVisible();
  });

  test("identity fields render from the node's identity", async ({ page }) => {
    await page.locator("#settings-tab-account").click();

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
    await page.locator("#settings-tab-account").click();

    await expect(page.locator("#account-no-identity")).toBeVisible();
    await expect(page.locator("#account-retry")).toHaveCount(0);
  });

  test("adding a device is offered on the bundled node, with no developer mode", async ({
    page,
  }) => {
    await page.locator("#settings-tab-account").click();
    await scrollSettingsControlIntoView(page, "#add-device");
    await expect(page.locator("#add-device")).toBeEnabled();
  });
});

// ─── Account tab - device pairing ───────────────────────────────────────────

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

/** The namespaces an invite blob on screen actually carries. */
async function inviteNamespacesOnScreen(page: Page): Promise<string[]> {
  const blob = (await page.locator("#pair-invite").innerText()).trim();
  return JSON.parse(atob(blob.replace("mero-pair:", ""))).namespaces;
}

describeAfter35("Account tab - pairing needs no developer mode", () => {
  test("both halves of the exchange are offered on an ordinary session", async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);
    await mockPairingAPIs(page);
    await page.click('button[title="Settings"]');
    await page.locator("#settings-tab-account").click();

    await scrollSettingsControlIntoView(page, "#add-device");
    await expect(page.locator("#add-device")).toBeEnabled();
    await expect(page.locator("#pair-invite-input")).toBeVisible();
  });
});

describeAfter35("Account tab - device listing", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await mockPairingAPIs(page);
    await page.click('button[title="Settings"]');
    await page.locator("#settings-tab-account").click();
    await scrollSettingsControlIntoView(page, "#add-device");
  });

  test("one row per device, with its scope and its status", async ({ page }) => {
    const rows = page.locator(".data-table tbody tr");
    await expect(rows).toHaveCount(2);

    // This node's own device: no application scope at all, which is every app.
    await expect(rows.nth(0)).toContainText("All apps");
    await expect(rows.nth(0)).toContainText("This device");
    await expect(rows.nth(1)).toContainText("1 app");
    await expect(rows.nth(1)).toContainText("Active");
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

describeAfter35("Account tab - pairing wizard", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await mockPairingAPIs(page);
    await page.click('button[title="Settings"]');
    await page.locator("#settings-tab-account").click();
    await scrollSettingsControlIntoView(page, "#add-device");
    await page.locator("#add-device").click();
  });

  test("the scope step opens on everything, with no app picker in the way", async ({
    page,
  }) => {
    await expect(page.locator("#pair-scope-all")).toBeChecked();
    await expect(page.locator("#pair-app-list")).toHaveCount(0);
    await expect(page.locator("#pair-scope-next")).toBeEnabled();
  });

  test("everything hands the new device every namespace", async ({ page }) => {
    await page.locator("#pair-scope-next").click();

    // Decoded, not matched as text: the ids are inside base64, where a substring
    // assertion would pass on a blob that names the wrong set.
    expect(await inviteNamespacesOnScreen(page)).toEqual([
      MOCK_NAMESPACE_ID,
      MOCK_OTHER_NAMESPACE_ID,
    ]);
  });

  test("choosing one app narrows the invite to that app's namespaces", async ({
    page,
  }) => {
    await page.locator("#pair-scope-apps").check();
    await page.locator(`#pair-app-${MOCK_OTHER_APPLICATION_ID}`).check();
    await page.locator("#pair-scope-next").click();

    expect(await inviteNamespacesOnScreen(page)).toEqual([MOCK_OTHER_NAMESPACE_ID]);
  });

  test("the app picker is labelled by namespace, not by a raw id", async ({
    page,
  }) => {
    await page.locator("#pair-scope-apps").check();

    await expect(page.locator("#pair-app-list")).toContainText("Personal");
    await expect(page.locator("#pair-app-list")).toContainText("Files");
    await expect(page.locator("#pair-app-list")).not.toContainText(
      MOCK_APPLICATION_ID,
    );
  });

  test("choosing no app leaves nothing to invite anyone to", async ({ page }) => {
    await page.locator("#pair-scope-apps").check();

    await expect(page.locator("#pair-scope-next")).toBeDisabled();
  });

  test("step 1 hands over an invite blob", async ({ page }) => {
    await page.locator("#pair-scope-next").click();

    await expect(page.locator("#pair-invite")).toContainText("mero-pair:");
    await expect(page.locator("#copy-pair-invite")).toBeVisible();
  });

  test("step 2 takes the response and the code in separate fields", async ({
    page,
  }) => {
    await page.locator("#pair-scope-next").click();
    await page.locator("#pair-next").click();

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
    await page.locator("#pair-scope-next").click();
    await page.locator("#pair-next").click();
    await page.fill("#pair-response", "mero-pair-reply:" + btoa('{"deviceId":"abc"}'));

    await expect(page.locator("#pair-invalid")).toContainText(
      "deviceId must be 64 hex characters",
    );
    await expect(page.locator("#pair-complete")).toBeDisabled();
  });

  test("linking shows a loader and then the success state", async ({ page }) => {
    await page.locator("#pair-scope-next").click();
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

describeAfter35("Account tab - pairing responder", () => {
  test.beforeEach(async ({ page }) => {
    await setupDeveloperPage(page);
    await mockPairingAPIs(page);
    await page.click('button[title="Settings"]');
    await page.locator("#settings-tab-account").click();
    await scrollSettingsControlIntoView(page, "#pair-invite-input");
  });

  test("an invite yields a response blob and a spoken confirmation code", async ({
    page,
  }) => {
    await page.fill("#pair-invite-input", MOCK_PAIR_INVITE_BLOB);
    await page.locator("#pair-init").click();

    await expect(page.locator("#pair-confirmation-code")).toHaveText(
      MOCK_PAIR_INIT.confirmationCode,
    );
    await expect(page.locator("#pair-reply")).toContainText("mero-pair-reply:");

    // Decoded, not searched: the code would not appear in the base64 text even
    // if the blob carried it, so a text assertion here would prove nothing.
    const blob = (await page.locator("#pair-reply").innerText()).trim();
    const body = JSON.parse(atob(blob.replace("mero-pair-reply:", "")));
    expect(Object.keys(body).sort()).toEqual([
      "deviceId",
      "kemPublicKey",
      "signPublicKey",
      "statement",
    ]);
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

describeAfter35("Settings toasts render", () => {
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
