import { test, expect } from "@playwright/test";
import { describeAfter35 } from "./fixtures/e2e-cap";
import {
  getInvokeCalls,
  mockContextAPIs,
  mockCoreAPIs,
  navigateVia,
  seedDeveloperState,
  stubTauriInvoke,
  waitForAppShellReady,
} from "./fixtures/helpers";

/**
 * Logs viewer tests (Nodes page → View Logs).
 *
 * Unlike the other Nodes specs these drive the **v2** invoke bridge
 * (`stubTauriInvoke`) so the log commands actually resolve — that's what makes
 * the modal reachable and lets us assert the exact command each button fires.
 * The backend behaviour itself is covered by the `log_rotation` Rust tests.
 */

const NODE = "test-node";
const LOG_TAIL = "2026-08-11T10:00:00Z INFO first line\n2026-08-11T10:00:01Z INFO second line";

async function openLogs(page: import("@playwright/test").Page) {
  await navigateVia(page, "Nodes");
  await expect(page.getByTestId("shell-page-title")).toHaveText("Nodes");
  await page.getByRole("button", { name: "View Logs" }).click();
  await expect(page.getByRole("heading", { name: `Logs: ${NODE}` })).toBeVisible();
}

describeAfter35("Nodes – logs viewer", () => {
  test.beforeEach(async ({ page }) => {
    await stubTauriInvoke(page, {
      list_merod_nodes: [NODE],
      detect_running_merod_nodes: [],
      get_merod_binary_version: "0.11.0-rc.20",
      // Every command whose result the page treats as an array has to be
      // stubbed: unstubbed commands resolve to null, and the Nodes page feeds
      // this one straight into state (`versions.reduce`), so a null takes the
      // whole page down through the error boundary before the logs modal exists.
      list_installed_merod_versions: [],
      list_merod_releases: [],
      get_merod_logs: LOG_TAIL,
      clear_merod_logs: "Cleared logs (2 rotated segment(s) removed)",
      export_merod_logs: { path: `/Users/tester/Downloads/merod-${NODE}.txt`, bytes: 5 * 1024 * 1024 },
    });
    await mockCoreAPIs(page);
    await mockContextAPIs(page);
    await page.goto("/");
    await seedDeveloperState(page);
    await page.reload();
    await waitForAppShellReady(page);
  });

  test("shows the fetched log tail", async ({ page }) => {
    await openLogs(page);
    await expect(page.getByText("first line")).toBeVisible();
    await expect(page.getByText("second line")).toBeVisible();
  });

  test("Download saves the full history via export_merod_logs", async ({ page }) => {
    await openLogs(page);
    await page.getByRole("button", { name: "Download" }).click();

    // The export must target the selected node and carry a suggested .txt name —
    // that name is what the save dialog seeds, so a wrong one ships a wrong file.
    await expect
      .poll(async () => (await getInvokeCalls(page)).map((c) => c.cmd))
      .toContain("export_merod_logs");
    const call = (await getInvokeCalls(page)).find((c) => c.cmd === "export_merod_logs");
    expect(call?.args?.nodeName).toBe(NODE);
    expect(call?.args?.defaultFileName).toMatch(/^merod-test-node-[\d-]+\.txt$/);

    // A successful export reports where the file landed.
    await expect(page.getByText(/Saved 5\.0 MB of logs/)).toBeVisible();
  });

  test("a cancelled save dialog is silent — no error toast", async ({ page }) => {
    // The command resolves to null when the user dismisses the picker.
    await page.evaluate(() => {
      const internals = (window as any).__TAURI_INTERNALS__;
      const original = internals.invoke;
      internals.invoke = (cmd: string, args: unknown) =>
        cmd === "export_merod_logs"
          ? (((window as any).__invokeCalls.push({ cmd, args })), Promise.resolve(null))
          : original(cmd, args);
    });
    await openLogs(page);
    await page.getByRole("button", { name: "Download" }).click();

    await expect
      .poll(async () => (await getInvokeCalls(page)).map((c) => c.cmd))
      .toContain("export_merod_logs");
    await expect(page.getByText(/Failed to save logs/)).toHaveCount(0);
    await expect(page.getByText(/Saved .* of logs/)).toHaveCount(0);
  });

  test("Clear wipes the logs on disk and re-reads them", async ({ page }) => {
    await openLogs(page);
    await page.getByRole("button", { name: "Clear" }).click();
    await expect
      .poll(async () => (await getInvokeCalls(page)).map((c) => c.cmd))
      .toContain("clear_merod_logs");
    await expect(page.getByText("Logs cleared")).toBeVisible();
  });
});
