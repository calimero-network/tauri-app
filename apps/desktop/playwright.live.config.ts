import { defineConfig, devices } from "@playwright/test";

const UI_PORT = Number(process.env["LIVE_UI_PORT"]) || 1420; // another checkout's Vite may already hold 1420
const UI_URL = `http://localhost:${UI_PORT}`;

/**
 * The live suite: the desktop UI against REAL merod nodes, three of them, so a
 * flow that needs other members (an upgrade reaching a peer, or a node that
 * only replicates) is tested end to end. `e2e/` stays mocked and never reaches a node; this suite starts its own
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
    baseURL: UI_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm dev --port ${UI_PORT}`,
    url: UI_URL,
    reuseExistingServer: process.env.GITHUB_ACTIONS !== "true",
    timeout: 120_000,
  },
});
