import { test, expect } from "./fixtures/test";
import { stubTauriInvoke } from "./fixtures/helpers";
import { MOCK_PROVIDERS_RESPONSE } from "./fixtures/mock-data";

const NODE_PORT = 37094;
const NODE_URL = `http://localhost:${NODE_PORT}`;

test("an existing node on a custom port passes onboarding's auth check", async ({ page }) => {
  await stubTauriInvoke(page, {
    list_merod_nodes: ["default"],
    check_merod_health: { healthy: true },
  });
  // Fail detection once so the automatic continue gives up and the user picks the node by hand.
  await page.addInitScript((port: number) => {
    const bridge = (window as any).__TAURI_INTERNALS__;
    const invoke = bridge.invoke;
    let detections = 0;
    bridge.invoke = (cmd: string, args: unknown) => {
      if (cmd !== "detect_running_merod_nodes") return invoke(cmd, args);
      detections += 1;
      return detections === 1
        ? Promise.reject(new Error("detection failed"))
        : Promise.resolve([{ node_name: "default", port, pid: 1 }]);
    };
  }, NODE_PORT);
  await page.route(`${NODE_URL}/auth/health`, (route) => route.fulfill({ json: { data: { status: "alive" } } }));
  await page.route(`${NODE_URL}/auth/providers`, (route) => route.fulfill({ json: MOCK_PROVIDERS_RESPONSE }));

  await page.goto("/");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Continue|Get Started|Set Up/ }).last().click();
  await page.getByRole("button", { name: /Use existing node/ }).click();
  await page.getByRole("button", { name: "Start Node & Continue" }).click();

  await expect(page.getByRole("heading", { name: /Connect to Calimero Cloud|Sign in|Log in|Login/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Authentication Service Unavailable" })).toHaveCount(0);
});
