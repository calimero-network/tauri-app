import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the Vite dev server (web UI). Native Tauri APIs are not exercised here.
 * @see https://playwright.dev/
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html"], ["github"]] : "list",
  globalSetup: "./playwright-global-setup.ts",
  use: {
    // Use localhost (not 127.0.0.1): Vite’s default bind on macOS is often IPv6-only,
    // so 127.0.0.1 never becomes ready and webServer times out.
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    // Use GITHUB_ACTIONS, not CI: some dev environments set CI=1 (e.g. Cursor), which
    // would force a fresh server and collide with an already-running Vite on 1420.
    reuseExistingServer: process.env.GITHUB_ACTIONS !== "true",
    timeout: 120_000,
  },
});
