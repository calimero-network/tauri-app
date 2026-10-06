import { test, expect } from "./fixtures/test";
import {
  getInvokeCalls,
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

test.describe("Nodes – logs viewer", () => {
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
      get_merod_logs_range: {
        content: "2026-08-11T10:00:01Z INFO in the window",
        matched: 1,
        truncated: false,
      },
      clear_merod_logs: "Cleared logs (2 rotated segment(s) removed)",
      export_merod_logs: { path: `/Users/tester/Downloads/merod-${NODE}.txt`, bytes: 5 * 1024 * 1024 },
    });
    await mockCoreAPIs(page);
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
  test("a preset time range reads the window from the whole history", async ({ page }) => {
    await openLogs(page);
    const before = Date.now();
    await page.getByRole("combobox", { name: "Time range" }).selectOption({ label: "Last hour" });

    await expect(page.getByText("in the window")).toBeVisible();
    await expect(page.getByText("1 line(s) in range")).toBeVisible();
    const call = (await getInvokeCalls(page)).find((c) => c.cmd === "get_merod_logs_range");
    expect(call?.args?.nodeName).toBe(NODE);
    // "Last hour" is resolved to an absolute lower bound at fetch time, open-ended.
    const fromMs = call?.args?.fromMs as number;
    expect(fromMs).toBeGreaterThanOrEqual(before - 3_600_000 - 1_000);
    expect(fromMs).toBeLessThanOrEqual(Date.now() - 3_600_000 + 1_000);
    expect(call?.args?.toMs).toBeUndefined();
  });

  test("a custom range is fetched only on Apply, with both bounds", async ({ page }) => {
    await openLogs(page);
    await page.getByRole("combobox", { name: "Time range" }).selectOption({ label: "Custom range…" });
    await page.getByLabel("From", { exact: true }).fill("2026-08-11T10:00");
    await page.getByLabel("To", { exact: true }).fill("2026-08-11T10:30");
    expect((await getInvokeCalls(page)).map((c) => c.cmd)).not.toContain("get_merod_logs_range");

    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("in the window")).toBeVisible();
    const call = (await getInvokeCalls(page)).find((c) => c.cmd === "get_merod_logs_range");
    // The end bound covers its whole minute.
    expect(call?.args?.fromMs).toBe(new Date("2026-08-11T10:00").getTime());
    expect(call?.args?.toMs).toBe(new Date("2026-08-11T10:30").getTime() + 59_999);
  });

  test("an inverted custom range is refused without a fetch", async ({ page }) => {
    await openLogs(page);
    await page.getByRole("combobox", { name: "Time range" }).selectOption({ label: "Custom range…" });
    await page.getByLabel("From", { exact: true }).fill("2026-08-11T11:00");
    await page.getByLabel("To", { exact: true }).fill("2026-08-11T10:00");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page.getByText(/start of the time range is after its end/)).toBeVisible();
    expect((await getInvokeCalls(page)).map((c) => c.cmd)).not.toContain("get_merod_logs_range");
    await expect(page.getByText("first line")).toBeVisible();
  });
});
