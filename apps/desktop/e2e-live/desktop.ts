import { expect, type Browser, type Page } from "@playwright/test";
import { MeroJs } from "@calimero-network/mero-js";
import { ADMIN_PASSWORD, ADMIN_USER, mintTokens, type TokenPair } from "./nodes";

export async function admin(url: string): Promise<MeroJs> {
  const mero = new MeroJs({ baseUrl: url, credentials: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
  await mero.authenticate();
  return mero;
}

/** A desktop session on `nodeUrl`: what onboarding plus login leave behind. */
export async function openDesktop(
  browser: Browser,
  nodeUrl: string,
  registryUrl: string,
  tokens?: TokenPair,
  /** Answers the shell's `app_bundled_frontend`; without it the browser has no shell and every probe fails. */
  probe?: (appId: string, nodeUrl: string) => Promise<string | null>,
): Promise<Page> {
  tokens ??= await mintTokens(nodeUrl);
  const context = await browser.newContext();
  if (probe) {
    await context.exposeBinding("__bundledFrontend", (_source, appId: string, url: string) => probe(appId, url));
    await context.addInitScript(() => {
      const bundled = (window as unknown as { __bundledFrontend: (a: string, n: string) => Promise<string | null> })
        .__bundledFrontend;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        transformCallback: (cb: unknown) => cb,
        invoke: (cmd: string, args: { appId: string; nodeUrl: string }) => {
          if (cmd !== "app_bundled_frontend") throw new Error(`${cmd} is not available in the browser`);
          return bundled(args.appId, args.nodeUrl);
        },
      };
    });
  }
  const page = await context.newPage();
  await page.goto("/");
  await page.evaluate(
    ({ nodeUrl, registryUrl, tokens }) => {
      localStorage.setItem(
        "calimero-desktop-settings",
        JSON.stringify({
          nodeUrl,
          registries: [registryUrl],
          onboardingCompleted: true,
          tutorialCompleted: true,
          developerMode: true,
        }),
      );
      localStorage.setItem("calimero_access_token", tokens.access_token);
      localStorage.setItem("calimero_refresh_token", tokens.refresh_token);
      localStorage.setItem("calimero_token_expires_at", String(Date.now() + 3_600_000));
      localStorage.setItem("calimero-autostart-default-applied", "1");
    },
    { nodeUrl, registryUrl, tokens },
  );
  await page.reload();
  await expect(page.locator("aside.sidebar")).toBeVisible();
  return page;
}

export async function openNamespace(page: Page, applicationId: string, name: string) {
  await page.locator("aside.sidebar").getByTitle("Namespaces").click();
  await page.locator(`.ns-app-card[data-application-id="${applicationId}"]`).click();
  await page.locator(".ns-card", { hasText: name }).click();
  await expect(page.getByTestId("ns-upgrade-card")).toBeVisible();
}
