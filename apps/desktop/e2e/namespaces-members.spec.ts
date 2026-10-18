import { test, expect } from "./fixtures/test";
import { setupDeveloperPage, navigateVia } from "./fixtures/helpers";
import { MOCK_ACCOUNT_ID, mockNamespaceGraph } from "./fixtures/namespace-graph";

/** The member list marks this node's own account, which is what a member list is keyed by. */

test("the namespace member list marks this node's own row, and only that one", async ({ page }) => {
  await setupDeveloperPage(page);
  await mockNamespaceGraph(page, {
    namespaceId: "ns".padEnd(64, "0"),
    name: "Workspace",
    role: "Admin",
    contexts: [],
    subgroups: [],
  });
  await navigateVia(page, "Namespaces");
  await page.locator('.ns-app-card[data-application-id="installed-app-1"]').click();
  await page.locator(".ns-card").first().click();

  const mine = page.locator(".ns-member-row", { hasText: MOCK_ACCOUNT_ID.slice(0, 8) });
  const theirs = page.locator(".ns-member-row", { hasText: "someone else" });
  await expect(mine.locator(".ns-me-badge")).toHaveText("you");
  await expect(theirs).toBeVisible();
  await expect(theirs.locator(".ns-me-badge")).toHaveCount(0);
});
