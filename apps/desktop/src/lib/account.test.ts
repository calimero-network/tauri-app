import { describe, it, expect, vi } from "vitest";
import type { AccountDevice } from "./device-link";

vi.mock("./device-link", () => ({
  listAccountDevices: vi.fn(),
  relinkDevice: vi.fn(),
  revokeDevice: vi.fn(),
}));

import {
  canRevoke,
  canSync,
  canInviteDevices,
  deviceLabel,
  deviceScope,
  deviceScopeApps,
  deviceStatus,
  devicesEmptyMessage,
  effectiveScope,
  inScope,
  namespaceFollowState,
  nextScope,
  relinkSummary,
  rescopeSummary,
  accountAppRows,
  scopeHint,
  scopeLockHint,
  scopeSwitches,
  thisDeviceBanner,
} from "./account";

function device(overrides: Partial<AccountDevice> = {}): AccountDevice {
  return {
    deviceId: "a".repeat(64),
    signingKey: "EdSigningKey",
    isSelf: false,
    revoked: false,
    applications: [],
    namespaces: ["ns-1"],
    ...overrides,
  };
}

describe("deviceScope", () => {
  it("reads an empty application list as every application", () => {
    expect(deviceScope(device({ applications: [] }))).toBe("All apps");
  });

  it("counts a narrowed scope", () => {
    expect(deviceScope(device({ applications: ["App1"] }))).toBe("1 app");
    expect(deviceScope(device({ applications: ["App1", "App2"] }))).toBe("2 apps");
  });
});

describe("canSync", () => {
  it("offers the holder the repair for another live device", () => {
    expect(canSync(device(), true)).toBe(true);
  });

  it("withholds it from the holder's own device, which is never relinked", () => {
    expect(canSync(device({ isSelf: true }), true)).toBe(false);
  });

  it("withholds it from a withdrawn device", () => {
    expect(canSync(device({ revoked: true }), true)).toBe(false);
  });

  it("offers a node holding no root none, since only the holder can relink", () => {
    expect(canSync(device({ isSelf: true }), false)).toBe(false);
    expect(canSync(device(), false)).toBe(false);
  });
});

describe("canRevoke", () => {
  it("offers revocation for another live device", () => {
    expect(canRevoke(device(), true)).toBe(true);
  });

  it("withholds it from this node's own device", () => {
    expect(canRevoke(device({ isSelf: true }), true)).toBe(false);
  });

  it("withholds it from a device already withdrawn", () => {
    expect(canRevoke(device({ revoked: true }), true)).toBe(false);
  });

  it("withholds it from a device bound nowhere, since the route names a namespace", () => {
    expect(canRevoke(device({ namespaces: [] }), false)).toBe(false);
  });

  it("withholds it from a node that does not hold the account root", () => {
    expect(canRevoke(device(), false)).toBe(false);
  });
});

describe("relinkSummary", () => {
  it("counts what it repaired", () => {
    expect(relinkSummary({ linkedIn: ["ns-1", "ns-2"], skipped: ["ns-3"], pending: [] })).toBe(
      "Repaired 2 namespaces.",
    );
  });

  it("keeps the singular for one namespace", () => {
    expect(relinkSummary({ linkedIn: ["ns-1"], skipped: [], pending: [] })).toBe(
      "Repaired 1 namespace.",
    );
  });

  it("reads a relink that had nothing to do as up to date, however many it skipped", () => {
    expect(relinkSummary({ linkedIn: [], skipped: [], pending: [] })).toBe("Already up to date.");
    expect(relinkSummary({ linkedIn: [], skipped: ["ns-1", "ns-2"], pending: [] })).toBe(
      "Already up to date.",
    );
  });

  it("names the namespaces a retry could still reach", () => {
    expect(relinkSummary({ linkedIn: ["ns-1"], skipped: ["ns-2"], pending: ["ns-2"] })).toBe(
      "Repaired 1 namespace, 1 not reachable yet.",
    );
    expect(relinkSummary({ linkedIn: [], skipped: ["ns-2"], pending: ["ns-2"] })).toBe(
      "1 namespace not reachable yet. Try again shortly.",
    );
  });
});

describe("rescopeSummary", () => {
  const result = (descoped: string[], bound: string[]) => ({
    applications: ["App1"],
    descoped,
    bound,
  });

  it("counts the namespaces a narrowing took the device out of", () => {
    expect(rescopeSummary(result(["ns-1", "ns-2"], []))).toBe("Removed from 2 namespaces.");
  });

  it("counts the namespaces a widening carried it into", () => {
    expect(rescopeSummary(result([], ["ns-1"]))).toBe("Added to 1 namespace.");
  });

  it("says both ways in one sentence when a scope moved in both", () => {
    expect(rescopeSummary(result(["ns-1"], ["ns-2", "ns-3"]))).toBe(
      "Removed from 1 namespace, added to 2.",
    );
  });

  it("still confirms a change that moved no binding at all", () => {
    expect(rescopeSummary(result([], []))).toBe("Scope updated.");
  });
});

describe("devicesEmptyMessage", () => {
  const identity = (deviceId: string | null) =>
    ({ accountId: "acct", deviceId, publicKey: "pk", accountRootPublicKey: "root" }) as never;

  it("says a paired device is on the account rather than that none were found", () => {
    expect(devicesEmptyMessage(identity("dev-1"))).toContain("This device is on the account");
  });

  it("keeps the plain empty listing for a node holding no device row", () => {
    expect(devicesEmptyMessage(identity(null))).toBe("No devices found for this account.");
  });

  it("says a node with no account at all is not part of one", () => {
    expect(devicesEmptyMessage(null)).toBe("This node is not part of an account yet.");
  });
});

describe("canInviteDevices", () => {
  const id = (extra: Record<string, unknown>) =>
    ({ accountId: "acct", deviceId: "dev", ...extra }) as never;

  it("offers the invite on the node holding the account's root", () => {
    expect(canInviteDevices(id({ holdsAccountRoot: true }))).toBe(true);
  });

  it("withholds it from a device paired into an account held elsewhere", () => {
    expect(canInviteDevices(id({ holdsAccountRoot: false }))).toBe(false);
  });

  it("keeps offering it against a node too old to report the field", () => {
    expect(canInviteDevices(id({}))).toBe(true);
  });

  it("keeps offering it when there is no identity to judge by", () => {
    expect(canInviteDevices(null)).toBe(true);
  });
});

describe("devicesEmptyMessage on a device held elsewhere", () => {
  it("says the account is managed on the other device", () => {
    const identity = { accountId: "a", deviceId: "d", holdsAccountRoot: false } as never;
    expect(devicesEmptyMessage(identity)).toContain("held on another device");
  });
});

describe("inScope", () => {
  it("reads an empty scope as every application, which is core's convention", () => {
    expect(inScope(device({ applications: [] }), "App1")).toBe(true);
  });

  it("covers only the applications a narrowed scope names", () => {
    expect(inScope(device({ applications: ["App1"] }), "App1")).toBe(true);
    expect(inScope(device({ applications: ["App1"] }), "App2")).toBe(false);
  });
});

describe("deviceStatus", () => {
  it("calls a live device active", () => {
    expect(deviceStatus(device())).toBe("active");
  });

  it("names a withdrawn device revoked", () => {
    expect(deviceStatus(device({ revoked: true }))).toBe("revoked");
  });
});

describe("namespaceFollowState", () => {
  const namespace = { namespaceId: "ns-1", name: "Personal", targetApplicationId: "App1" };

  it("follows a namespace in scope that names the device's binding", () => {
    expect(
      namespaceFollowState(device({ namespaces: ["ns-1"], applications: ["App1"] }), namespace),
    ).toBe("following");
  });

  it("retires every namespace of a withdrawn device", () => {
    expect(namespaceFollowState(device({ revoked: true }), namespace)).toBe("retired");
  });

  it("says a namespace outside the scope is not in it, rather than not followed", () => {
    const narrow = device({ namespaces: ["ns-1"], applications: ["App2"] });
    expect(namespaceFollowState(narrow, namespace)).toBe("not-in-scope");
  });

  it("says a namespace in scope the device has no binding in is not followed", () => {
    const unbound = device({ namespaces: ["ns-2"], applications: ["App1"] });
    expect(namespaceFollowState(unbound, namespace)).toBe("not-following");
  });
});

describe("effectiveScope", () => {
  it("reads a narrowed scope straight off the listing", () => {
    expect(effectiveScope(device({ applications: ["App1"] }), ["App1", "App2"])).toEqual([
      "App1",
    ]);
  });

  it("spells an everything device out as every app the row lists", () => {
    expect(effectiveScope(device({ applications: [] }), ["App1", "App2"])).toEqual([
      "App1",
      "App2",
    ]);
  });
});

describe("nextScope", () => {
  const rows = ["App1", "App2", "App3"];

  it("asks for everything when the first switch goes on", () => {
    expect(nextScope(device({ applications: ["App1"] }), rows, { kind: "all", on: true })).toBe(
      "all",
    );
  });

  it("freezes today's access when the first switch goes off", () => {
    expect(nextScope(device({ applications: [] }), rows, { kind: "all", on: false })).toEqual({
      only: rows,
    });
  });

  it("drops one app off a narrowed scope", () => {
    expect(
      nextScope(device({ applications: ["App1", "App2"] }), rows, {
        kind: "app",
        applicationId: "App1",
        on: false,
      }),
    ).toEqual({ only: ["App2"] });
  });

  it("turns an everything device into the rest of the list when one app goes off", () => {
    expect(
      nextScope(device({ applications: [] }), rows, {
        kind: "app",
        applicationId: "App2",
        on: false,
      }),
    ).toEqual({ only: ["App1", "App3"] });
  });

  it("adds an app without ever asking for everything", () => {
    expect(
      nextScope(device({ applications: ["App1"] }), rows, {
        kind: "app",
        applicationId: "App3",
        on: true,
      }),
    ).toEqual({ only: ["App1", "App3"] });
  });

  it("names an app the scope already holds only once", () => {
    expect(
      nextScope(device({ applications: ["App1"] }), rows, {
        kind: "app",
        applicationId: "App1",
        on: true,
      }),
    ).toEqual({ only: ["App1"] });
  });
});

describe("scopeSwitches", () => {
  const rows = ["App1", "App2"];

  it("switches both ways on a narrowed device the holder can change", () => {
    expect(scopeSwitches(device({ applications: ["App1"] }), rows, true)).toEqual({
      all: { on: false, locked: false },
      apps: {
        // The only app left on: core refuses an empty scope.
        App1: { on: true, locked: true },
        App2: { on: false, locked: false },
      },
    });
  });

  it("reads an everything device as every app on, each still switchable off", () => {
    expect(scopeSwitches(device({ applications: [] }), rows, true)).toEqual({
      all: { on: true, locked: false },
      apps: {
        App1: { on: true, locked: false },
        App2: { on: true, locked: false },
      },
    });
  });

  it("locks the first switch while the row lists no app to fall back on", () => {
    expect(scopeSwitches(device({ applications: [] }), [], true)).toEqual({
      all: { on: true, locked: true },
      apps: {},
    });
  });

  it("locks the lot on a node that does not hold the account root", () => {
    expect(scopeSwitches(device({ applications: ["App1"] }), rows, false)).toEqual({
      all: { on: false, locked: true },
      apps: {
        App1: { on: true, locked: true },
        App2: { on: false, locked: true },
      },
    });
  });

  it("locks the lot on a withdrawn device, which no scope change reaches", () => {
    expect(scopeSwitches(device({ revoked: true, applications: ["App1"] }), rows, true)).toEqual({
      all: { on: false, locked: true },
      apps: {
        App1: { on: true, locked: true },
        App2: { on: false, locked: true },
      },
    });
  });

  it("locks the holder's own row, which follows everything by definition", () => {
    expect(scopeSwitches(device({ isSelf: true, applications: [] }), rows, true)).toEqual({
      all: { on: true, locked: true },
      apps: {
        App1: { on: true, locked: true },
        App2: { on: true, locked: true },
      },
    });
  });
});

describe("scopeLockHint", () => {
  const rows = ["App1", "App2"];

  it("puts a withdrawal ahead of every other reason", () => {
    expect(scopeLockHint(device({ revoked: true }), true, rows)).toBe(
      "Revoked devices cannot be changed.",
    );
  });

  it("names the computer that can change a scope, for a node holding no root", () => {
    expect(scopeLockHint(device(), false, rows)).toBe(
      "Only the computer holding the account root can change scope.",
    );
  });

  it("says the holder's own row follows everything", () => {
    expect(scopeLockHint(device({ isSelf: true }), true, rows)).toBe(
      "This device follows everything, including apps added later.",
    );
  });

  it("says what an account needs before a device can be limited at all", () => {
    expect(scopeLockHint(device({ applications: [] }), true, [])).toBe(
      "Add an app to the account before limiting this device.",
    );
  });

  it("says why the last app left on cannot be switched off", () => {
    expect(scopeLockHint(device({ applications: ["App1"] }), true, rows)).toBe(
      "A device acts for at least one app. Revoke it to remove it entirely.",
    );
  });

  it("says nothing at all when every switch on the row can move", () => {
    expect(scopeLockHint(device({ applications: [] }), true, rows)).toBeNull();
  });
});

describe("scopeHint", () => {
  it("says what an empty scope really means", () => {
    expect(scopeHint(device({ applications: [] }), 3)).toBe(
      "everything, including apps added later",
    );
  });

  it("counts a narrowed scope against what the account has", () => {
    expect(scopeHint(device({ applications: ["App1"] }), 3)).toBe("1 of 3 apps");
  });
});

describe("deviceScopeApps", () => {
  const applications = [
    { applicationId: "App1", namespaces: ["ns-1"] },
    { applicationId: "App2", namespaces: ["ns-2"] },
  ];
  const namespaces = [
    { namespaceId: "ns-1", name: "Personal", targetApplicationId: "App1" },
    { namespaceId: "ns-2", name: "Files", targetApplicationId: "App2" },
  ];

  it("offers every app the account speaks in", () => {
    expect(
      deviceScopeApps(applications, device({ applications: ["App1"] }), namespaces, []).map(
        (tile) => tile.applicationId,
      ),
    ).toEqual(["App2", "App1"]);
  });

  it("keeps an app the device's scope names after the account stopped using it", () => {
    const tiles = deviceScopeApps(
      applications,
      device({ applications: ["App3"] }),
      namespaces,
      [{ id: "App3", name: "Notes" }],
    );
    expect(tiles.map((tile) => tile.name)).toEqual(["Files", "Personal", "Notes"]);
  });

  it("names an app the node has installed by its own name, not by a namespace", () => {
    const tiles = deviceScopeApps(applications, device({ applications: ["App1"] }), namespaces, [
      { id: "App1", name: "Mero Chat" },
    ]);
    expect(tiles.find((tile) => tile.applicationId === "App1")?.name).toBe("Mero Chat");
  });

  it("offers nothing extra for a device that already follows everything", () => {
    expect(
      deviceScopeApps(applications, device({ applications: [] }), namespaces, []).length,
    ).toBe(2);
  });
});

describe("thisDeviceBanner", () => {
  it("warns in red that this device was withdrawn from the account", () => {
    expect(thisDeviceBanner([device({ isSelf: true, revoked: true })])).toContain(
      "can no longer write",
    );
  });

  it("says nothing while this device is still on the account", () => {
    expect(thisDeviceBanner([device({ isSelf: true })])).toBeNull();
  });
});

describe("accountAppRows", () => {
  const applications = [
    { applicationId: "App1", namespaces: ["ns-1", "ns-2"] },
    { applicationId: "App2", namespaces: ["ns-3"] },
  ];
  const namespaces = [
    { namespaceId: "ns-1", name: "Personal", targetApplicationId: "App1" },
    { namespaceId: "ns-2", name: "Work", targetApplicationId: "App1" },
    { namespaceId: "ns-3", name: "Files", targetApplicationId: "App2" },
  ];
  const installed = [
    {
      id: "App1",
      name: "Mero Chat",
      package: "calimero/mero-chat",
      version: "1.2.0",
      blob: { bytecode: "b".repeat(64) },
    },
    // A row a followed namespace wrote: named, with coordinates, but no blob.
    { id: "App2", name: "Mero Drive", package: "calimero/mero-drive", version: "2.0.0" },
  ];

  it("counts the namespaces an app is spoken in and the devices that reach it", () => {
    const devices = [
      device({ applications: [] }),
      device({ applications: ["App1"] }),
      device({ applications: ["App1"], revoked: true }),
    ];
    expect(accountAppRows(applications, devices, namespaces, installed)).toEqual([
      {
        applicationId: "App1",
        name: "Mero Chat",
        package: "calimero/mero-chat",
        version: "1.2.0",
        namespaces: 2,
        devices: 2,
        installed: true,
      },
      {
        applicationId: "App2",
        name: "Mero Drive",
        package: "calimero/mero-drive",
        version: "2.0.0",
        namespaces: 1,
        devices: 1,
        installed: false,
      },
    ]);
  });

  it("names an app this node has no row for, and offers it no coordinates", () => {
    const rows = accountAppRows(applications, [], namespaces, []);
    const row = rows.find((entry) => entry.applicationId === "App1");
    expect(row).toEqual({
      applicationId: "App1",
      name: "Personal, Work",
      namespaces: 2,
      devices: 0,
      installed: false,
    });
  });

  it("lists nothing for an account whose namespaces target no app", () => {
    expect(accountAppRows([], [], [], [])).toEqual([]);
  });
});

describe("deviceLabel", () => {
  const paired = "b".repeat(64);

  it("names a device the node holds an alias for", () => {
    expect(deviceLabel(paired, { "Alice's iPad": paired })).toBe("Alice's iPad");
  });

  it("names nothing for a device no alias points at", () => {
    expect(deviceLabel("c".repeat(64), { "Alice's iPad": paired })).toBeNull();
  });

  it("takes the first of several aliases on one device, as the node lists them", () => {
    expect(deviceLabel(paired, { iPad: paired, "Old iPad": paired })).toBe("iPad");
  });

  it("names nothing when the node holds no aliases at all", () => {
    expect(deviceLabel(paired, {})).toBeNull();
  });
});
