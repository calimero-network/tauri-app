import { describe, it, expect, vi, beforeEach } from "vitest";

// Every one of these is a network or Tauri call; the point of the test is the
// decision tree around them, not the calls themselves.
const listInstalledApps = vi.fn();
const invalidateInstalledApps = vi.fn();
const openAppFrontend = vi.fn();
const installApplication = vi.fn();
const fetchAppsFromRegistry = vi.fn();
const redeemInvitation = vi.fn();

vi.mock("../utils/installedAppsCache", () => ({
  listInstalledApps: (...a: unknown[]) => listInstalledApps(...a),
  invalidateInstalledApps: (...a: unknown[]) => invalidateInstalledApps(...a),
}));
vi.mock("../utils/registry", () => ({
  fetchAppsFromRegistry: (...a: unknown[]) => fetchAppsFromRegistry(...a),
}));
vi.mock("../lib/mero-client", () => ({
  apiClient: {
    node: { installApplication: (...a: unknown[]) => installApplication(...a) },
    meroJs: { admin: { redeemInvitation: (...a: unknown[]) => redeemInvitation(...a) } },
  },
}));
vi.mock("../utils/appUtils", () => ({
  openAppFrontend: (...a: unknown[]) => openAppFrontend(...a),
  decodeMetadata: (m: unknown) => m,
  sleep: () => Promise.resolve(),
  isAllowedAppFrontendUrl: (url: string) => url.startsWith("https://"),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  LINK_DEDUP_MS,
  canResolveDeepLinks,
  createLinkDedup,
  deepLinkRaw,
  joinInvitedNamespace,
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
    // The link rides beside the URL, so an app that is already open can be
    // handed it too: focusing an open window does not reload it.
    expect(openAppFrontend).toHaveBeenCalledWith(
      "https://drive.example",
      "Mero Drive",
      expect.any(Function),
      {
        applicationId: "app-1",
        deepLink: {
          raw: "calimero://com.calimero.drive/join?invitation=abc",
          params: "invitation=abc",
        },
      },
    );
  });

  it("names the link the way an app's launcher bridge delivers it", () => {
    expect(deepLinkRaw(LINK)).toBe("calimero://com.calimero.drive/join?invitation=abc");
    expect(deepLinkRaw({ ...LINK, params: "" })).toBe("calimero://com.calimero.drive/join");
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

describe("a deep link waits for the user to be signed in", () => {
  const ready = { clientReady: true, checkingOnboarding: false, showOnboarding: false, showLogin: false };

  // The client is built before the token check routes a signed-out user to
  // login. Resolving then 401s into `retry` until the drain gives up, and the
  // invite was lost by the time the user had signed in.
  it("does not resolve behind the login screen, though the client is ready", () => {
    expect(canResolveDeepLinks({ ...ready, showLogin: true })).toBe(false);
  });

  it("does not resolve during onboarding or before the client exists", () => {
    expect(canResolveDeepLinks({ ...ready, showOnboarding: true })).toBe(false);
    expect(canResolveDeepLinks({ ...ready, checkingOnboarding: true })).toBe(false);
    expect(canResolveDeepLinks({ ...ready, clientReady: false })).toBe(false);
  });

  it("resolves once signed in", () => {
    expect(canResolveDeepLinks(ready)).toBe(true);
  });
});

describe("the same link delivered twice", () => {
  it("acts once when the live event and the cold drain both deliver it", () => {
    let t = 1_000;
    const dedup = createLinkDedup(() => t);
    expect(dedup.claim(LINK)).toBe(true);
    expect(dedup.claim(LINK)).toBe(false); // in flight
    dedup.settle(LINK, "opened");
    t += 1_000;
    expect(dedup.claim(LINK)).toBe(false); // just handled
  });

  it("acts again when the user follows the same invite later", () => {
    let t = 1_000;
    const dedup = createLinkDedup(() => t);
    dedup.claim(LINK);
    dedup.settle(LINK, "forget");
    t += LINK_DEDUP_MS + 1;
    expect(dedup.claim(LINK)).toBe(true);
  });

  it("lets a retry be claimed again at once, and other links through", () => {
    const dedup = createLinkDedup(() => 1_000);
    dedup.claim(LINK);
    expect(dedup.claim({ ...LINK, params: "invitation=other" })).toBe(true);
    dedup.settle(LINK, "retry");
    expect(dedup.claim(LINK)).toBe(true);
  });
});

describe("an invite link joins the namespace as the desktop", () => {
  // The app's own client key cannot join a namespace this node has never held,
  // so the desktop joins first and the app finds itself already a member.
  const NS = "dda0bfa125cdffc453bd5474bdeb45db828f24197c667bf03e88df8d7a86437d";
  const payload = { invitation: { invitation: { group_id: NS }, sig: "s" }, groupAlias: "Team" };
  const INVITE = `invitation=${encodeURIComponent(JSON.stringify(payload))}`;

  it("joins before opening the app", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    const order: string[] = [];
    redeemInvitation.mockImplementation(async () => {
      order.push("join");
      return { status: "joined", namespaceId: NS };
    });
    openAppFrontend.mockImplementation(async () => {
      order.push("open");
    });
    const r = recorder();

    await resolveAndOpen({ ...LINK, params: INVITE }, r.report, agree);

    expect(redeemInvitation).toHaveBeenCalledWith(NS, payload.invitation, { teamName: "Team" });
    expect(order).toEqual(["join", "open"]);
    expect(r.done).toContain("Joined “Team”");
  });

  it("still opens the app when the join fails, and says why", async () => {
    redeemInvitation.mockResolvedValue({
      status: "failed",
      namespaceId: NS,
      message: "invitation expired.",
      reason: "expired",
      retryable: false,
    });
    const r = recorder();

    await joinInvitedNamespace(INVITE, "Mero Chat", r.report);

    expect(r.failures).toEqual([
      "Could not join “Team”: invitation expired. Opening Mero Chat anyway.",
    ]);
    expect(r.cleared).toEqual(r.shown);
  });

  it("says nothing extra for an already-member", async () => {
    redeemInvitation.mockResolvedValue({ status: "already-member", namespaceId: NS });
    const r = recorder();

    await joinInvitedNamespace(INVITE, "Mero Chat", r.report);

    expect(r.failures).toEqual([]);
    expect(r.done).toEqual([]);
  });

  it("leaves params that are not a namespace invitation to the app", async () => {
    const r = recorder();
    await joinInvitedNamespace("invitation=abc", "Mero Chat", r.report);
    await joinInvitedNamespace("room=42", "Mero Chat", r.report);
    expect(redeemInvitation).not.toHaveBeenCalled();
    expect(r.shown).toEqual([]);
  });

  it("does not join for an action other than join", async () => {
    listInstalledApps.mockResolvedValue({ data: [INSTALLED] });
    await resolveAndOpen({ ...LINK, action: "open", params: INVITE }, recorder().report, agree);
    expect(redeemInvitation).not.toHaveBeenCalled();
  });
});
