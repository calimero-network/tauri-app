import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import type { LiveState } from "../e2e-live/global-setup";
import { appLabel } from "../e2e-live/frontend";
import { ADMIN_PASSWORD, ADMIN_USER, mintTokens } from "../e2e-live/nodes";
import { startRecorder } from "./recorder";
import { Session, startDriver, until } from "./webdriver";

/**
 * The built desktop on a real node: Open on an app whose bundle ships its
 * frontend opens an app window on `calimero-app://{label}/{version}/`.
 *
 * tauri-driver reaches only the main window: an app window has a web context of
 * its own, which WebKitWebDriver does not list. So the window is observed from
 * outside. The node sits behind a recording proxy, and the test asserts what the
 * shell asked for: the landing URL its Rust probe derives, the document and assets
 * fetched under the app's Host, and the page's API calls carrying a token.
 * Not covered here: the page's DOM, a write, a reload and the bare-origin redirect.
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
  await admin.admin.createContext({ applicationId, groupId: namespaceId, name: "general" });
  const label = appLabel(applicationId);
  const landing = `calimero-app://${label}/${live.frontend.version}/`;

  const recorder = await startRecorder(node.url);
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
      [recorder.url, live.registryUrl, tokens],
    );
    const nav = "aside.sidebar [title='Applications']";
    await until("the sidebar", () => session.find({ css: nav }));
    await session.clickIn(nav);
    const open = `[data-app-id="${applicationId}"] [data-testid="open-app"]`;
    await until("Open on the app's card", () => session.find({ css: open }));
    await session.clickIn(open);

    // The window exists, and the shell's own probe lands where the node's redirect does.
    await until("the app window", async () => {
      const x = spawnSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" }).stdout ?? "";
      return x.includes('"KV Store"');
    });
    const probed = await session.run<string | null>(
      `return window.__TAURI_INTERNALS__.invoke("app_bundled_frontend", { appId: arguments[0], nodeUrl: arguments[1] })`,
      [applicationId, recorder.url],
    );
    expect(probed).toBe(landing);

    // The page came from the node through the scheme handler, under the app's Host.
    const own = (r: { host: string }) => r.host.startsWith(`${label}.localhost`);
    await until("the document and its script", async () => {
      const mine = recorder.seen.filter(own);
      return (
        mine.some((r) => r.path === `/${live.frontend!.version}/` && r.status === 200) &&
        mine.some((r) => r.path.endsWith(".js") && r.status === 200)
      );
    });

    // The page got a session: it calls the node with a token of its own, not the desktop's.
    await until("an authenticated call from the page", async () =>
      recorder.seen.some(
        (r) => own(r) && !r.path.startsWith(`/${live.frontend!.version}/`) && r.authorization && r.authorization !== `Bearer ${tokens.access_token}`,
      ),
    );
  } catch (e) {
    const where = await session.url().catch(() => "?");
    const seen = await session.text().catch(() => "?");
    const handles = await session.handles().catch(() => []);
    const x = spawnSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" }).stdout ?? "";
    throw new Error(`${String(e)}\nat ${where}, windows ${JSON.stringify(handles)}\n${seen.slice(-1500)}\n${x}`);
  } finally {
    await session.end().catch(() => undefined);
    driver.kill();
    recorder.close();
  }
});
