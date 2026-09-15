import { test, expect } from "./fixtures/test";
import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  MOCK_PROVIDERS_RESPONSE,
  MOCK_HEALTH_OK,
  API_ROUTES,
} from "./fixtures/mock-data";
import {
  setupAuthenticatedPage,
  mockRegistryAPIs,
  navigateVia,
} from "./fixtures/helpers";

/**
 * macOS text substitutions must be off in every field.
 *
 * ⚠️ WHY THIS IS A SUITE AND NOT A ONE-LINE PROP. The sign-in form already
 * carried `autoCapitalize`/`autoCorrect`/`spellCheck` — added the last time
 * this bit someone — and the ~40 other inputs in the app did not, which is
 * exactly how the capitalised first letter came back on the onboarding
 * credentials screen. The fix is central (`utils/inputHygiene.ts`), so the
 * guard checks fields the fix has never been told about by name, including one
 * on a page that does not exist when the app boots.
 */

const expectNoSubstitutions = async (
  field: import("@playwright/test").Locator,
) => {
  await expect(field).toHaveAttribute("autocapitalize", "off");
  await expect(field).toHaveAttribute("autocorrect", "off");
  await expect(field).toHaveAttribute("spellcheck", "false");
};

test.describe("text substitutions are off", () => {
  test("the admin credentials the node is created with are not autocapitalised", async ({
    page,
  }) => {
    // ⚠️ THE WORST CASE IN THE APP. The admin username typed here is the one
    // you will log in with forever, so a silent capital at the front is a
    // credential you cannot reproduce.
    for (const route of [API_ROUTES.health, API_ROUTES.providers]) {
      await page.route(route, (r) =>
        r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            route === API_ROUTES.health ? MOCK_HEALTH_OK : MOCK_PROVIDERS_RESPONSE,
          ),
        }),
      );
    }

    await page.goto("/");
    await page.evaluate(
      ([settingsKey, progressKey, settings, progress]) => {
        localStorage.setItem(settingsKey, JSON.stringify(settings));
        localStorage.setItem(progressKey, JSON.stringify(progress));
      },
      [
        STORAGE_KEYS.settings,
        STORAGE_KEYS.onboardingProgress,
        { ...DEFAULT_SETTINGS, nodeUrl: "http://localhost:2528" },
        {
          currentStep: "login",
          dataDir: "~/.calimero",
          nodeName: "default",
          serverPort: 2528,
          swarmPort: 2428,
          nodeSetupMode: "create-new",
          useExistingNode: null,
          nodeCreated: true,
          nodeStarted: true,
          savedAt: Date.now(),
        },
      ] as const,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /Set Up Authentication/i }),
    ).toBeVisible({ timeout: 30_000 });

    await expectNoSubstitutions(page.locator("#auth-admin-user"));
    await expectNoSubstitutions(page.locator("#auth-admin-password"));
  });

  test("a field on a page mounted long after boot is covered too", async ({
    page,
  }) => {
    // The MutationObserver is the load-bearing half: most of this app's fields
    // live in modals and pages that do not exist at startup, so a one-shot
    // sweep on load would cover almost nothing.
    await mockRegistryAPIs(page);
    await setupAuthenticatedPage(page);
    await navigateVia(page, "Marketplace");

    await expectNoSubstitutions(
      page.locator('input[placeholder="Search applications..."]'),
    );
  });
});
