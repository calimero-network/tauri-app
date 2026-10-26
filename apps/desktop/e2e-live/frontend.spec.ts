import { test, expect } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import type { LiveState } from "./global-setup";
import { openDesktop } from "./desktop";
import { appLabel, bundledFrontend, serveApp } from "./frontend";
import { ADMIN_PASSWORD, ADMIN_USER } from "./nodes";

/**
 * An app whose bundle ships its frontend: the node serves it on the app's own
 * `{label}.localhost` origin, and the desktop's cards find it by probing the
 * node. A bundle without a frontend gets no Open.
 *
 * The browser has no Rust shell, so the probe is answered by `bundledFrontend`
 * (the same request the shell's `app_bundled_frontend` makes). The shell itself
 * is covered by app-window.spec.ts.
 */

const state = (): LiveState => JSON.parse(process.env["LIVE_STATE"] ?? "null") as LiveState;

test("a bundled frontend is served by the node and offered by the desktop's cards", async ({ browser }) => {
  const live = state();
  if (!live.frontend || !live.plain) throw new Error("set LIVE_FRONTEND_BUNDLE and LIVE_PLAIN_BUNDLE");
  const node = live.nodes[0]!;
  const admin = new MeroJs({ baseUrl: node.url, credentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  await admin.authenticate();
  const withFrontend = (await admin.admin.installApplication(live.frontend)).applicationId;
  const without = (await admin.admin.installApplication(live.plain)).applicationId;

  // The node serves the bundle's frontend at the app's origin, after its redirect to the version path.
  const label = appLabel(withFrontend);
  const served = await serveApp(label, node.url);
  expect(served.status).toBe(200);
  expect(served.path).toBe(`/${live.frontend.version}/`);
  expect(String(served.headers["content-type"])).toContain("text/html");
  expect(served.body).toContain('<div id="root"');

  // The probe is held, so the cards are seen while it is out and after it answers.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const page = await openDesktop(browser, node.url, live.registryUrl, undefined, async (appId, nodeUrl) => {
    await held;
    return bundledFrontend(appId, nodeUrl);
  });
  await page.locator("aside.sidebar").getByTitle("Applications").click();
  const card = (id: string) => page.locator(`[data-testid="installed-app-card"][data-app-id="${id}"]`);

  await expect(card(withFrontend)).toContainText("Checking...");
  await expect(card(without)).toContainText("Checking...");
  release();

  await expect(card(withFrontend).getByTestId("open-app")).toBeVisible();
  await expect(card(withFrontend)).not.toContainText("Checking...");
  await expect(card(without)).toContainText("No web frontend");
  await expect(card(without).getByTestId("open-app")).toHaveCount(0);
});
