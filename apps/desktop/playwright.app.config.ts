import { defineConfig } from "@playwright/test";

/**
 * The built desktop app under tauri-driver, against the same real merod and
 * registry as the live suite (e2e-live/global-setup.ts). Linux only: it needs
 * WebKitWebDriver. Needs DESKTOP_BINARY; see .github/workflows/e2e-live.yml.
 */
export default defineConfig({
  testDir: "./e2e-app",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e-live/global-setup.ts",
  timeout: 300_000,
  expect: { timeout: 60_000 },
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
});
