import { describe, it, expect, vi, beforeEach } from "vitest";

// Every one of these is a network or Tauri call; the point of the test is the
// decision tree around them, not the calls themselves.
const listInstalledApps = vi.fn();
const invalidateInstalledApps = vi.fn();
const openAppFrontend = vi.fn();
const installApplication = vi.fn();
const fetchAppsFromRegistry = vi.fn();

vi.mock("../utils/installedAppsCache", () => ({
  listInstalledApps: (...a: unknown[]) => listInstalledApps(...a),
  invalidateInstalledApps: (...a: unknown[]) => invalidateInstalledApps(...a),
}));
vi.mock("../utils/registry", () => ({
  fetchAppsFromRegistry: (...a: unknown[]) => fetchAppsFromRegistry(...a),
}));
vi.mock("../lib/mero-client", () => ({
  apiClient: { node: { installApplication: (...a: unknown[]) => installApplication(...a) } },
}));
vi.mock("../utils/appUtils", () => ({
  openAppFrontend: (...a: unknown[]) => openAppFrontend(...a),
  appendParamsToUrl: (url: string, params: string) => (params ? `${url}?${params}` : url),
  decodeMetadata: (m: unknown) => m,
  sleep: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { resolveAndOpen, supersede, type Reporter } from "./useAppDeepLink";

/** A Reporter that records what the user would have been shown. */
function recorder() {
  const shown: string[] = [];
  const cleared: string[] = [];
  const failures: string[] = [];
  const done: string[] = [];
  const report: Reporter = {
    progress: (m) => {
      shown.push(m);
      return () => cleared.push(m);
    },
    failed: (m) => failures.push(m),
    done: (m) => done.push(m),
  };
  return { report, shown, cleared, failures, done };
}

const LINK = { slug: "com.calimero.drive", action: "join", params: "invitation=abc" };

const INSTALLED = {
  id: "app-1",
  package: "com.calimero.drive",
  metadata: { name: "Mero Drive", links: { frontend: "https://drive.example" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  openAppFrontend.mockResolvedValue(undefined);
});

describe("a deep link always tells the user what happened", () => {
  it("opens an installed app, and says so while it does", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report)).toBe("opened");

    // The action is named, because "Opening…" alone does not tell the user
    // their invite was understood.
    expect(r.shown.some((m) => m.includes("Mero Drive") && m.includes("join"))).toBe(true);
    // ...and the progress message is always taken back down.
    expect(r.cleared).toEqual(r.shown);
    expect(r.failures).toEqual([]);
    expect(openAppFrontend).toHaveBeenCalledWith(
      "https://drive.example?invitation=abc",
      "Mero Drive",
      expect.any(Function),
      { applicationId: "app-1" },
    );
  });

  it("installs on demand, and shows the install rather than hanging silently", async () => {
    listInstalledApps
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [INSTALLED] });
    fetchAppsFromRegistry.mockResolvedValue([{ id: "com.calimero.drive", latest_version: "1.2.3" }]);
    installApplication.mockResolvedValue({ data: { applicationId: "app-1" } });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report)).toBe("opened");

    expect(r.shown.some((m) => m.includes("Installing") && m.includes("1.2.3"))).toBe(true);
    expect(r.done.some((m) => m.includes("Installed"))).toBe(true);
    expect(r.cleared).toEqual(r.shown);
    expect(r.failures).toEqual([]);
  });

  // The three terminal cases below all used to `return 'forget'` after a
  // console.warn, which on screen is identical to never having clicked.
  it("says so when the package is not published", async () => {
    listInstalledApps.mockResolvedValue({ data: [] });
    fetchAppsFromRegistry.mockResolvedValue([]);
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report)).toBe("forget");
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("not published");
    expect(r.cleared).toEqual(r.shown);
  });

  it("surfaces the node's own reason when the install is refused", async () => {
    listInstalledApps.mockResolvedValue({ data: [] });
    fetchAppsFromRegistry.mockResolvedValue([{ id: "com.calimero.drive", latest_version: "1.2.3" }]);
    installApplication.mockResolvedValue({ error: { message: "bundle rejected: minRuntimeVersion" } });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report)).toBe("forget");
    expect(r.failures[0]).toContain("bundle rejected: minRuntimeVersion");
  });

  it("says so when the app declares no frontend", async () => {
    listInstalledApps.mockResolvedValue({
      data: [{ id: "app-1", package: "com.calimero.drive", metadata: { name: "Mero Drive" } }],
    });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report)).toBe("forget");
    expect(r.failures[0]).toContain("no frontend");
  });

  // A cold node is the one case that is NOT the user's problem and must not be
  // reported as a failure — the drain retries it.
  it("stays quiet and retries when the node cannot list apps yet", async () => {
    listInstalledApps.mockResolvedValue({ error: { message: "node not ready" } });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report)).toBe("retry");
    expect(r.failures).toEqual([]);
    expect(r.shown).toEqual([]);
  });

  // The drain holds a "waiting for the node" message up across retries. The
  // attempt that gets through must take it down as it starts talking, not when
  // it finishes — install-on-demand sits in between, and that is the slow step
  // the whole change exists to narrate.
  it("drops the waiting message the moment the resolver has anything to say", async () => {
    listInstalledApps
      .mockResolvedValueOnce({ error: { message: "node not ready" } })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [INSTALLED] });
    fetchAppsFromRegistry.mockResolvedValue([{ id: "com.calimero.drive", latest_version: "1.2.3" }]);
    installApplication.mockResolvedValue({ data: { applicationId: "app-1" } });

    const r = recorder();
    let waiting = false;
    const stop = () => {
      waiting = false;
    };
    const drainReport = supersede(stop, r.report);

    expect(await resolveAndOpen(LINK, drainReport)).toBe("retry");
    // Nothing was said, so the drain puts the waiting message up.
    waiting = true;

    // Whatever the next attempt shows, the waiting message is already gone by
    // the time that message is on screen.
    const seenWhileWaiting: string[] = [];
    const watched: Reporter = {
      progress: (m) => {
        const clear = drainReport.progress(m);
        if (waiting) seenWhileWaiting.push(m);
        return clear;
      },
      failed: (m) => drainReport.failed(m),
      done: (m) => drainReport.done(m),
    };
    expect(await resolveAndOpen(LINK, watched)).toBe("opened");

    expect(r.shown.some((m) => m.includes("Installing"))).toBe(true);
    expect(seenWhileWaiting).toEqual([]);
    expect(waiting).toBe(false);
  });
});
