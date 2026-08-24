/**
 * The `test` object every e2e spec must import, instead of `@playwright/test`
 * directly.
 *
 * It installs one auto-fixture: nothing in the suite may reach a REAL node.
 *
 * These tests run against the Vite dev server in a browser, and the app reads
 * its node URL from localStorage, defaulting to http://localhost:2528. That is
 * also the port the shipped Calimero Desktop runs its node on — so on a
 * developer machine the suite would happily talk to a live personal node,
 * skip onboarding, and assert against whatever state that node happened to be
 * in.
 *
 * This used to be handled in playwright-global-setup.ts by `pkill -f merod`
 * plus `rm -rf ~/.calimero/{default,node1}` — which fixed the interference by
 * destroying the developer's real node: its identity keypair and database,
 * not a test fixture. Blocking the requests achieves the same isolation
 * without touching anything outside the browser, and works even when a node is
 * running (it no longer has to not exist).
 *
 * Requests to the node origin are aborted as if nothing were listening, which
 * is exactly what the app expects to see when there is no node.
 *
 * Registration order matters: this runs BEFORE each test body, and Playwright
 * matches the most recently registered handler first, so any `page.route` a
 * spec adds for a specific endpoint still takes precedence over this catch-all.
 */
import { test as base, expect } from "@playwright/test";

import { DEFAULT_NODE_URL } from "./mock-data";

export const test = base.extend<{ blockAmbientNode: void }>({
  blockAmbientNode: [
    async ({ page }, use) => {
      await page.route(`${DEFAULT_NODE_URL}/**`, (route) =>
        route.abort("connectionrefused"),
      );
      await use();
    },
    { auto: true },
  ],
});

export { expect };
