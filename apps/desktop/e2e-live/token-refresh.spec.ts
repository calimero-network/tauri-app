import { test, expect } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import type { LiveState } from "./global-setup";
import { openDesktop } from "./desktop";
import { ADMIN_PASSWORD, ADMIN_USER, JWT_LEEWAY_S, mintTokens } from "./nodes";

/**
 * A desktop session that outlives its access token: the node refuses the old
 * token, the desktop rotates it once, and stays signed in on the new pair.
 */

const state = (): LiveState => JSON.parse(process.env["LIVE_STATE"] ?? "null") as LiveState;

function jwtExpiryMs(token: string): number {
  return (JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { exp: number }).exp * 1000;
}

test("a desktop whose access token expired refreshes it and stays signed in", async ({ browser }) => {
  const live = state();
  const node = live.nodes[0]!;
  const admin = new MeroJs({ baseUrl: node.url, credentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  await admin.authenticate();
  const { applicationId } = await admin.admin.installApplication({ package: live.package, version: live.older });
  await admin.admin.createNamespace({ applicationId, name: "Refresh test" });

  const tokens = await mintTokens(node.url);
  const refusedAt = jwtExpiryMs(tokens.access_token) + (JWT_LEEWAY_S + 2) * 1000;
  await new Promise((r) => setTimeout(r, Math.max(0, refusedAt - Date.now())));
  const stale = await fetch(`${node.url}/admin-api/namespaces`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  expect(stale.status).toBe(401);

  const page = await openDesktop(browser, node.url, live.registryUrl, tokens);
  await page.locator("aside.sidebar").getByTitle("Namespaces").click({ timeout: 60_000 });
  await expect(page.locator(`.ns-app-card[data-application-id="${applicationId}"]`)).toBeVisible();

  const stored = await page.evaluate(() => ({
    access: localStorage.getItem("calimero_access_token"),
    refresh: localStorage.getItem("calimero_refresh_token"),
  }));
  expect(stored.refresh).toBeTruthy();
  expect(stored.refresh).not.toBe(tokens.refresh_token);
  const fresh = await fetch(`${node.url}/admin-api/namespaces`, {
    headers: { Authorization: `Bearer ${stored.access}` },
  });
  expect(fresh.status).toBe(200);
});
