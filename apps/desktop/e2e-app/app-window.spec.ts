import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import type { LiveState } from "../e2e-live/global-setup";
import { appLabel } from "../e2e-live/frontend";
import { ADMIN_PASSWORD, ADMIN_USER, mintTokens } from "../e2e-live/nodes";
import { Session, startDriver, until } from "./webdriver";

/**
 * The built desktop on a real node: Open on an app whose bundle ships its
 * frontend opens an app window on `calimero-app://{label}/{version}/`, and
 * that page gets a session, writes, survives a reload and follows the node's
 * redirect from the bare origin.
 */

const state = (): LiveState => JSON.parse(process.env["LIVE_STATE"] ?? "null") as LiveState;

test("Open shows a bundled app in its own window on calimero-app://", async () => {
  const live = state();
  if (!live.frontend) throw new Error("set LIVE_FRONTEND_BUNDLE");
  const binary = process.env["DESKTOP_BINARY"];
  if (!binary) throw new Error("set DESKTOP_BINARY to the built desktop app");
  const node = live.nodes[0]!;

  const admin = new MeroJs({ baseUrl: node.url, credentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  await admin.authenticate();
  const { applicationId } = await admin.admin.installApplication(live.frontend);
  const { namespaceId } = await admin.admin.createNamespace({ applicationId, name: "App window" });
  const { contextId } = await admin.admin.createContext({ applicationId, groupId: namespaceId, name: "general" });
  const label = appLabel(applicationId);
  const origin = `calimero-app://${label}`;
  const landing = `${origin}/${live.frontend.version}/`;

  const home = mkdtempSync(path.join(os.tmpdir(), "desktop-app-e2e-"));
  const driver = await startDriver({
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
  });
  const session = await Session.start(binary);
  try {
    // The main window, signed in to the node as onboarding and login leave it.
    const tokens = await mintTokens(node.url);
    await until("the main window", async () => (await session.find({ css: "#root" })) !== undefined);
    await session.run(
      `const [nodeUrl, registryUrl, tokens] = arguments;
       localStorage.setItem("calimero-desktop-settings", JSON.stringify({ nodeUrl, registries: [registryUrl],
         onboardingCompleted: true, tutorialCompleted: true, developerMode: true }));
       localStorage.setItem("calimero_access_token", tokens.access_token);
       localStorage.setItem("calimero_refresh_token", tokens.refresh_token);
       localStorage.setItem("calimero_token_expires_at", String(Date.now() + 3600000));
       localStorage.setItem("calimero-autostart-default-applied", "1");
       location.reload();`,
      [node.url, live.registryUrl, tokens],
    );
    const main = await session.handle();
    const sidebar = await until("the sidebar", () => session.find({ css: "aside.sidebar [title='Applications']" }));
    await session.click(sidebar);
    const open = await until("Open on the app's card", () =>
      session.find({ css: `[data-app-id="${applicationId}"] [data-testid="open-app"]` }),
    );
    await session.click(open);

    // The app window opens on the app's origin, at the version the node redirects to.
    const appWindow = await until("the app window", async () =>
      (await session.handles()).find((h) => h !== main),
    );
    await session.switchTo(appWindow);
    await until("the app window on its version path", async () => (await session.url()).startsWith(landing));

    // The session arrived through the hand-off: the app lists its context, not the login.
    await until("the context picker", async () => (await session.text()).includes("Choose a context"));
    const text = await session.text();
    expect(text).not.toContain("Connect a node");
    expect(text).not.toContain("No application id");
    expect(text).toContain(contextId);
    await session.click((await session.find({ xpath: "//button[text()='Open']" }))!);

    // A write through the UI shows in the list.
    await until("the write form", () => session.find({ css: "input[aria-label='key']" }));
    await session.type((await session.find({ css: "input[aria-label='key']" }))!, "greeting");
    await session.type((await session.find({ css: "input[aria-label='value']" }))!, "hello from the desktop");
    await session.click((await session.find({ xpath: "//button[text()='set']" }))!);
    await until("the entry in the list", async () => {
      const t = await session.text();
      return t.includes("greeting") && t.includes("hello from the desktop");
    });

    // A reload of a deep link keeps the session and its data.
    await session.navigate(`${landing}some/deep/route?x=1`);
    await until("the entry after a reload", async () => {
      const t = await session.text();
      return t.includes("hello from the desktop") && !t.includes("Connect a node");
    });
    expect(await session.url()).toBe(`${landing}some/deep/route?x=1`);

    // The bare origin lands on the version path, through the node's redirect.
    await session.navigate(`${origin}/`);
    await until("the bare origin to land on the version path", async () => (await session.url()) === landing);
    await until("the app after the redirect", async () => (await session.text()).includes("KV Store"));
  } finally {
    await session.end().catch(() => undefined);
    driver.kill();
  }
});
