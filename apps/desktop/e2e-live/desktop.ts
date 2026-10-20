import { expect, type Browser, type Page } from "@playwright/test";
import { mintTokens, type TokenPair } from "./nodes";

/** A desktop session on `nodeUrl`: what onboarding plus login leave behind. */
export async function openDesktop(
  browser: Browser,
  nodeUrl: string,
  registryUrl: string,
  tokens?: TokenPair,
): Promise<Page> {
  tokens ??= await mintTokens(nodeUrl);
  const context = await browser.newContext();
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
