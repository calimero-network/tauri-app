import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the Vite dev server (web UI). Native Tauri APIs are not exercised here.
 * @see https://playwright.dev/
 */
export default defineConfig({
  testDir: "./e2e",
  expect: {
    // Default 5s is too tight after reload: onboarding + node checks can take several seconds.
    timeout: 15_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html"], ["github"]] : "list",
  // No globalSetup. It used to `pkill -f merod` and `rm -rf
  // ~/.calimero/{default,node1}` so a live node could not answer on 2528 and
  // bypass onboarding — but ~/.calimero/default is where the shipped Desktop
  // keeps the developer's REAL node, so running the suite destroyed its
  // identity and database, and the unscoped pkill took down every other merod
  // on the machine too. e2e/fixtures/test.ts now blocks requests to the node
  // origin instead, which isolates the tests without touching anything outside
  // the browser.
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
