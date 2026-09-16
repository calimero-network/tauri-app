import { describe, it, expect, vi } from "vitest";
import type { NodeIdentity } from "@calimero-network/mero-js";
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
  followsAccount,
  inScope,
  namespaceFollowState,
  relinkSummary,
  accountAppRows,
  reportedAccountNamespace,
  scopeHint,
  scopeToggle,
  thisDeviceBanner,
  widenSummary,
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

  it("leaves a node holding no root only its own row", () => {
    expect(canSync(device({ isSelf: true }), false)).toBe(true);
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
  it("names both counts", () => {
    expect(relinkSummary({ linkedIn: ["ns-1", "ns-2"], skipped: ["ns-3"] })).toBe(
      "Repaired 2 namespaces, skipped 1.",
    );
  });

  it("keeps the singular for one namespace", () => {
    expect(relinkSummary({ linkedIn: ["ns-1"], skipped: [] })).toBe(
      "Repaired 1 namespace, skipped 0.",
    );
  });

  it("says so plainly when the relink reached nothing at all", () => {
    expect(relinkSummary({ linkedIn: [], skipped: [] })).toBe("Nothing to repair.");
  });

  it("still reports skips when nothing was repaired", () => {
    expect(relinkSummary({ linkedIn: [], skipped: ["ns-1"] })).toBe(
      "Repaired 0 namespaces, skipped 1.",
    );
  });
});

describe("widenSummary", () => {
  it("counts the apps added and the namespaces they reached", () => {
    expect(widenSummary({ linkedIn: ["ns-1", "ns-2"], skipped: ["ns-3"] }, 2)).toBe(
      "Added 2 apps, reaching 2 more namespaces.",
    );
  });

  it("says it in the singular for one app and one namespace", () => {
    expect(widenSummary({ linkedIn: ["ns-1"], skipped: [] }, 1)).toBe(
      "Added 1 app, reaching 1 more namespace.",
    );
  });

  it("reports an add that reached nowhere rather than implying it landed", () => {
    expect(widenSummary({ linkedIn: [], skipped: ["ns-1"] }, 1)).toBe(
      "Added 1 app, reaching 0 more namespaces.",
    );
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

function identity(overrides: Partial<NodeIdentity> = {}): NodeIdentity {
  return {
    accountId: "a".repeat(64),
    deviceId: "b".repeat(64),
    publicKey: "EdDevicePublicKey",
    accountRootPublicKey: "c".repeat(64),
    holdsAccountRoot: true,
    accountNamespaceId: "9".repeat(64),
    ...overrides,
  };
}

const ACCOUNT_NS = "9".repeat(64);

describe("inScope", () => {
  it("reads an empty scope as every application, which is core's convention", () => {
    expect(inScope(device({ applications: [] }), "App1")).toBe(true);
  });

  it("covers only the applications a narrowed scope names", () => {
    expect(inScope(device({ applications: ["App1"] }), "App1")).toBe(true);
    expect(inScope(device({ applications: ["App1"] }), "App2")).toBe(false);
  });
});

describe("reportedAccountNamespace", () => {
  it("takes the id once a device in the listing is bound into it", () => {
    const devices = [device({ namespaces: [ACCOUNT_NS, "ns-1"] })];
    expect(reportedAccountNamespace(devices, ACCOUNT_NS)).toBe(ACCOUNT_NS);
  });

  it("holds nothing back to accuse with on a node whose listing never names it", () => {
    expect(reportedAccountNamespace([device({ namespaces: ["ns-1"] })], ACCOUNT_NS)).toBeNull();
    expect(reportedAccountNamespace([device()], null)).toBeNull();
  });
});

describe("followsAccount", () => {
  it("follows it when the device is bound into the account namespace", () => {
    expect(followsAccount(device({ namespaces: [ACCOUNT_NS] }), ACCOUNT_NS)).toBe(true);
  });

  it("does not follow it when the binding is missing", () => {
    expect(followsAccount(device({ namespaces: ["ns-1"] }), ACCOUNT_NS)).toBe(false);
  });

  it("accuses nobody where the account namespace is not reported at all", () => {
    expect(followsAccount(device({ namespaces: ["ns-1"] }), null)).toBe(true);
  });
});

describe("deviceStatus", () => {
  it("calls a live, bound device active", () => {
    expect(deviceStatus(device({ namespaces: [ACCOUNT_NS] }), ACCOUNT_NS, false)).toBe("active");
  });

  it("puts a withdrawal ahead of everything else it could say", () => {
    expect(deviceStatus(device({ revoked: true }), ACCOUNT_NS, true)).toBe("revoked");
  });

  it("says syncing while we are waiting for the listing to catch up", () => {
    expect(deviceStatus(device({ namespaces: [ACCOUNT_NS] }), ACCOUNT_NS, true)).toBe("syncing");
  });

  it("names a device that never picked the account up", () => {
    expect(deviceStatus(device({ namespaces: ["ns-1"] }), ACCOUNT_NS, false)).toBe(
      "not-following",
    );
  });
});

describe("namespaceFollowState", () => {
  const namespace = { namespaceId: "ns-1", name: "Personal", targetApplicationId: "App1" };
  const bound = () => device({ namespaces: [ACCOUNT_NS, "ns-1"], applications: ["App1"] });

  it("follows a namespace in scope that names the device's binding", () => {
    expect(namespaceFollowState(bound(), namespace, ACCOUNT_NS, false)).toBe("following");
  });

  it("retires every namespace of a withdrawn device", () => {
    expect(
      namespaceFollowState(device({ revoked: true }), namespace, ACCOUNT_NS, false),
    ).toBe("retired");
  });

  it("syncs a namespace the device is reaching for but has not bound", () => {
    expect(namespaceFollowState(bound(), namespace, ACCOUNT_NS, true)).toBe("syncing");
  });

  it("says a namespace outside the scope is not in it, rather than not followed", () => {
    const narrow = device({ namespaces: [ACCOUNT_NS], applications: ["App2"] });
    expect(namespaceFollowState(narrow, namespace, ACCOUNT_NS, false)).toBe("not-in-scope");
  });

  it("says a namespace in scope with no binding is simply not followed", () => {
    const unbound = device({ namespaces: [ACCOUNT_NS], applications: ["App1"] });
    expect(namespaceFollowState(unbound, namespace, ACCOUNT_NS, false)).toBe("not-following");
  });

  it("does not claim a namespace is followed by a device that skipped the account", () => {
    const legacy = device({ namespaces: ["ns-1"], applications: ["App1"] });
    expect(namespaceFollowState(legacy, namespace, ACCOUNT_NS, false)).toBe("not-following");
  });
});

describe("scopeToggle", () => {
  it("offers the only change core supports, which is switching one on", () => {
    expect(scopeToggle(device({ applications: ["App1"] }), "App2", true)).toEqual({
      on: false,
      locked: false,
    });
  });

  it("locks the off direction, since core cannot narrow without a fresh pairing", () => {
    expect(scopeToggle(device({ applications: ["App1"] }), "App1", true)).toEqual({
      on: true,
      locked: true,
      tip: "Narrowing a scope needs a fresh pairing",
    });
  });

  it("locks every toggle on for a device that already follows everything", () => {
    expect(scopeToggle(device({ applications: [] }), "App1", true)).toEqual({
      on: true,
      locked: true,
      tip: "This device follows everything, including apps added later",
    });
  });

  it("locks the lot on a node that does not hold the account root", () => {
    expect(scopeToggle(device({ applications: ["App1"] }), "App2", false)).toEqual({
      on: false,
      locked: true,
      tip: "Only the computer holding the account root can change scope",
    });
  });

  it("locks a withdrawn device, which no relink reaches", () => {
    expect(scopeToggle(device({ revoked: true, applications: ["App1"] }), "App2", true)).toEqual({
      on: false,
      locked: true,
      tip: "Revoked devices cannot be changed",
    });
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
  const identity = (extra: Record<string, unknown>) =>
    ({ accountId: "acct", deviceId: "d".repeat(64), ...extra }) as never;

  it("warns in red that this device was withdrawn from the account", () => {
    const banner = thisDeviceBanner(identity({ holdsAccountRoot: false }), [
      device({ isSelf: true, revoked: true }),
    ]);
    expect(banner?.kind).toBe("revoked");
    expect(banner?.text).toContain("can no longer write");
  });

  it("points a device paired by an older version at the link code", () => {
    const banner = thisDeviceBanner(
      identity({ holdsAccountRoot: false, accountNamespaceId: null }),
      [device({ isSelf: true })],
    );
    expect(banner?.kind).toBe("legacy");
    expect(banner?.text).toContain("does not follow the account yet");
  });

  it("says nothing on a device that follows the account", () => {
    const followed = identity({ holdsAccountRoot: false, accountNamespaceId: ACCOUNT_NS });
    expect(thisDeviceBanner(followed, [device({ isSelf: true })])).toBeNull();
  });

  it("says nothing on the node holding the account root", () => {
    expect(thisDeviceBanner(identity({ holdsAccountRoot: true }), [])).toBeNull();
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
