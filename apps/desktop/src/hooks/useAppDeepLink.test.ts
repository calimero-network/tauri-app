import { describe, it, expect, vi, beforeEach } from "vitest";

// Every one of these is a network or Tauri call; the point of the test is the
// decision tree around them, not the calls themselves.
const listInstalledApps = vi.fn();
const invalidateInstalledApps = vi.fn();
const openAppFrontend = vi.fn();
const installApplication = vi.fn();
const fetchAppsFromRegistry = vi.fn();
const describeContextDeletion = vi.fn();
const deleteContext = vi.fn();

vi.mock("../utils/installedAppsCache", () => ({
  listInstalledApps: (...a: unknown[]) => listInstalledApps(...a),
  invalidateInstalledApps: (...a: unknown[]) => invalidateInstalledApps(...a),
}));
vi.mock("../utils/registry", () => ({
  fetchAppsFromRegistry: (...a: unknown[]) => fetchAppsFromRegistry(...a),
}));
vi.mock("../lib/mero-client", () => ({
  apiClient: {
    node: {
      installApplication: (...a: unknown[]) => installApplication(...a),
      describeContextDeletion: (...a: unknown[]) => describeContextDeletion(...a),
      deleteContext: (...a: unknown[]) => deleteContext(...a),
    },
  },
}));
vi.mock("../utils/appUtils", () => ({
  openAppFrontend: (...a: unknown[]) => openAppFrontend(...a),
  appendParamsToUrl: (url: string, params: string) => (params ? `${url}?${params}` : url),
  decodeMetadata: (m: unknown) => m,
  sleep: () => Promise.resolve(),
  isAllowedAppFrontendUrl: (url: string) => url.startsWith("https://"),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  resolveAndOpen,
  supersede,
  type DeepLinkConsentRequest,
  type Reporter,
} from "./useAppDeepLink";

/** The user agreeing to whatever they are asked; each question is recorded. */
const agree = vi.fn(async (_req: DeepLinkConsentRequest) => true);

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
  agree.mockImplementation(async () => true);
});

describe("a deep link always tells the user what happened", () => {
  it("opens an installed app, and says so while it does", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("opened");

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

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("opened");

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

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("forget");
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("not published");
    expect(r.cleared).toEqual(r.shown);
  });

  it("surfaces the node's own reason when the install is refused", async () => {
    listInstalledApps.mockResolvedValue({ data: [] });
    fetchAppsFromRegistry.mockResolvedValue([{ id: "com.calimero.drive", latest_version: "1.2.3" }]);
    installApplication.mockResolvedValue({ error: { message: "bundle rejected: minRuntimeVersion" } });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("forget");
    expect(r.failures[0]).toContain("bundle rejected: minRuntimeVersion");
  });

  it("says so when the app declares no frontend", async () => {
    listInstalledApps.mockResolvedValue({
      data: [{ id: "app-1", package: "com.calimero.drive", metadata: { name: "Mero Drive" } }],
    });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("forget");
    expect(r.failures[0]).toContain("no frontend");
  });

  // A cold node is the one case that is NOT the user's problem and must not be
  // reported as a failure — the drain retries it.
  it("stays quiet and retries when the node cannot list apps yet", async () => {
    listInstalledApps.mockResolvedValue({ error: { message: "node not ready" } });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("retry");
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

    expect(await resolveAndOpen(LINK, drainReport, agree)).toBe("retry");
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
    expect(await resolveAndOpen(LINK, watched, agree)).toBe("opened");

    expect(r.shown.some((m) => m.includes("Installing"))).toBe(true);
    expect(seenWhileWaiting).toEqual([]);
    expect(waiting).toBe(false);
  });
});

// A deep-link is attacker input: any web page can send the user to
// calimero://<package>/<action>, and any app window can emit `app-deep-link`.
describe("a deep link never acts without the user's consent", () => {
  const PUBLISHED = {
    id: "com.calimero.drive",
    name: "Mero Drive",
    latest_version: "1.2.3",
    verified: true,
    publisherVerified: true,
    links: { frontend: "https://drive.example/app" },
  };

  it("asks before installing, and installs nothing when the user declines", async () => {
    listInstalledApps.mockResolvedValue({ data: [] });
    fetchAppsFromRegistry.mockResolvedValue([PUBLISHED]);
    const decline = vi.fn(async () => false);
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report, decline)).toBe("forget");

    expect(decline).toHaveBeenCalledTimes(1);
    expect(decline).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "install",
        pkg: "com.calimero.drive",
        version: "1.2.3",
        frontendOrigin: "https://drive.example",
        params: "invitation=abc",
        verified: true,
      }),
    );
    expect(installApplication).not.toHaveBeenCalled();
    expect(openAppFrontend).not.toHaveBeenCalled();
    // Declining is the user's own answer, not a failure to report.
    expect(r.failures).toEqual([]);
    expect(r.cleared).toEqual(r.shown);
  });

  it("tells the user when the package is unverified", async () => {
    listInstalledApps.mockResolvedValue({ data: [] });
    fetchAppsFromRegistry.mockResolvedValue([
      { ...PUBLISHED, verified: false, publisherVerified: false },
    ]);
    const decline = vi.fn(async () => false);

    await resolveAndOpen(LINK, recorder().report, decline);

    expect(decline).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "install", verified: false, publisherVerified: false }),
    );
  });

  it("installs exactly the package the link names, never another registry hit", async () => {
    listInstalledApps.mockResolvedValue({ data: [] });
    fetchAppsFromRegistry.mockResolvedValue([{ ...PUBLISHED, id: "com.evil.lookalike" }]);
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("forget");
    expect(agree).not.toHaveBeenCalled();
    expect(installApplication).not.toHaveBeenCalled();
    expect(r.failures[0]).toContain("not published");
  });

  it("asks once for an install whose frontend matches what the user saw", async () => {
    listInstalledApps
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ ...INSTALLED, metadata: { name: "Mero Drive", links: { frontend: "https://drive.example/app" } } }],
      });
    fetchAppsFromRegistry.mockResolvedValue([PUBLISHED]);
    installApplication.mockResolvedValue({ data: { applicationId: "app-1" } });

    expect(await resolveAndOpen(LINK, recorder().report, agree)).toBe("opened");
    expect(agree).toHaveBeenCalledTimes(1);
    expect(openAppFrontend).toHaveBeenCalled();
  });

  it("asks again when the installed bundle opens somewhere other than the registry said", async () => {
    listInstalledApps
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ ...INSTALLED, metadata: { name: "Mero Drive", links: { frontend: "https://elsewhere.example" } } }],
      });
    fetchAppsFromRegistry.mockResolvedValue([PUBLISHED]);
    installApplication.mockResolvedValue({ data: { applicationId: "app-1" } });
    const consent = vi
      .fn(async (_req: DeepLinkConsentRequest) => false)
      .mockResolvedValueOnce(true);

    expect(await resolveAndOpen(LINK, recorder().report, consent)).toBe("forget");
    expect(consent).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "open", frontendOrigin: "https://elsewhere.example" }),
    );
    expect(openAppFrontend).not.toHaveBeenCalled();
  });

  it("asks before opening an installed app with the link's parameters", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    const decline = vi.fn(async () => false);

    expect(await resolveAndOpen(LINK, recorder().report, decline)).toBe("forget");
    expect(decline).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "open",
        appName: "Mero Drive",
        frontendOrigin: "https://drive.example",
        params: "invitation=abc",
      }),
    );
    expect(openAppFrontend).not.toHaveBeenCalled();
  });

  it("refuses a frontend that is not HTTPS without asking", async () => {
    listInstalledApps.mockResolvedValue({
      data: [{ ...INSTALLED, metadata: { name: "Mero Drive", links: { frontend: "http://evil.example" } } }],
    });
    const r = recorder();

    expect(await resolveAndOpen(LINK, r.report, agree)).toBe("forget");
    expect(agree).not.toHaveBeenCalled();
    expect(openAppFrontend).not.toHaveBeenCalled();
    expect(r.failures[0]).toContain("HTTPS");
  });
});

// An app window's token cannot install or delete (core answers 403), so an app
// hands those to the desktop as links the desktop carries out itself.
describe("actions the desktop carries out for an app", () => {
  const CALENDAR = { slug: "com.calimero.calendar", action: "install", params: "" };

  it("installs without opening anything, once the user agrees", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    fetchAppsFromRegistry.mockResolvedValue([{ id: "com.calimero.calendar", name: "Calendar", latest_version: "2.0.0" }]);
    installApplication.mockResolvedValue({ data: { applicationId: "app-2" } });
    const r = recorder();

    expect(await resolveAndOpen(CALENDAR, r.report, agree)).toBe("opened");

    expect(agree).toHaveBeenCalledWith(expect.objectContaining({ kind: "add", pkg: "com.calimero.calendar", version: "2.0.0" }));
    expect(installApplication).toHaveBeenCalledWith({ package: "com.calimero.calendar", version: "2.0.0" });
    expect(openAppFrontend).not.toHaveBeenCalled();
    expect(r.done).toEqual(["Installed Calendar"]);
  });

  it("installs nothing the user declined", async () => {
    listInstalledApps.mockResolvedValue({ data: [] });
    fetchAppsFromRegistry.mockResolvedValue([{ id: "com.calimero.calendar", latest_version: "2.0.0" }]);
    const r = recorder();

    expect(await resolveAndOpen(CALENDAR, r.report, vi.fn(async () => false))).toBe("forget");
    expect(installApplication).not.toHaveBeenCalled();
  });

  it("does not ask again for a package already installed", async () => {
    listInstalledApps.mockResolvedValue({ data: [{ ...INSTALLED, package: "com.calimero.calendar" }] });
    const r = recorder();

    expect(await resolveAndOpen(CALENDAR, r.report, agree)).toBe("opened");
    expect(agree).not.toHaveBeenCalled();
    expect(installApplication).not.toHaveBeenCalled();
    expect(r.done).toEqual(["Mero Drive is already installed"]);
  });

  const DELETE = { slug: "com.calimero.drive", action: "delete-context", params: "context=ctx-1" };

  it("deletes the app's own context and its empty namespace, once the user agrees", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    describeContextDeletion.mockResolvedValue({ data: { applicationId: "app-1", emptyGroup: "ns-1" } });
    deleteContext.mockResolvedValue({ data: { namespace: true } });
    const r = recorder();

    expect(await resolveAndOpen(DELETE, r.report, agree)).toBe("opened");

    expect(agree).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "delete", appName: "Mero Drive", contextId: "ctx-1", namespace: true }),
    );
    expect(deleteContext).toHaveBeenCalledWith("ctx-1", "ns-1");
    expect(openAppFrontend).not.toHaveBeenCalled();
    expect(r.done).toEqual(["Deleted from Mero Drive"]);
    expect(r.cleared).toEqual(r.shown);
  });

  it("refuses a context that runs another app, without asking", async () => {
    listInstalledApps.mockResolvedValue({
      data: [INSTALLED, { id: "app-9", package: "com.calimero.chat", metadata: { name: "Chat" } }],
    });
    describeContextDeletion.mockResolvedValue({ data: { applicationId: "app-9", emptyGroup: null } });
    const r = recorder();

    expect(await resolveAndOpen(DELETE, r.report, agree)).toBe("forget");
    expect(agree).not.toHaveBeenCalled();
    expect(deleteContext).not.toHaveBeenCalled();
    expect(r.failures[0]).toContain("does not belong to com.calimero.drive");
  });

  it("deletes nothing the user declined", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    describeContextDeletion.mockResolvedValue({ data: { applicationId: "app-1", emptyGroup: null } });
    const r = recorder();

    expect(await resolveAndOpen(DELETE, r.report, vi.fn(async () => false))).toBe("forget");
    expect(deleteContext).not.toHaveBeenCalled();
  });

  it("says why when the link names no context", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    const r = recorder();

    expect(await resolveAndOpen({ ...DELETE, params: "" }, r.report, agree)).toBe("forget");
    expect(describeContextDeletion).not.toHaveBeenCalled();
    expect(r.failures[0]).toContain("names no context");
  });
});
