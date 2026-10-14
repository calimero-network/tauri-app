import { defineConfig, devices } from "@playwright/test";

/**
 * The live suite: the desktop UI against REAL merod nodes, two of them, so a
 * flow that needs a second member (an upgrade reaching a peer) is tested end to
 * end. `e2e/` stays mocked and never reaches a node; this suite starts its own
 * on ports of its own (see e2e-live/global-setup.ts) and never touches 2528.
 *
 * Needs MEROD_BINARY and LIVE_BUNDLES (or LIVE_BUNDLE_DIR); see
 * .github/workflows/e2e-live.yml for how CI provides them.
 */
export default defineConfig({
  testDir: "./e2e-live",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e-live/global-setup.ts",
  // Nodes, peering and governance sync are real, so a step can take seconds.
  timeout: 300_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: process.env.GITHUB_ACTIONS !== "true",
    timeout: 120_000,
  },
});
