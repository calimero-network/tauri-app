import { describe, it, expect, vi } from "vitest";
import type { AccountDevice } from "../lib/device-link";

vi.mock("../lib/device-link", () => ({
  listAccountDevices: vi.fn(),
  relinkDevice: vi.fn(),
  revokeDevice: vi.fn(),
}));

import {
  canRevoke,
  canSync,
  canWiden,
  deviceScope,
  devicesEmptyMessage,
  relinkSummary,
  widenSummary,
} from "./AccountPanel";

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
  it("offers the repair for another live device", () => {
    expect(canSync(device())).toBe(true);
  });

  it("withholds it from this node's own device, which is never relinked", () => {
    expect(canSync(device({ isSelf: true }))).toBe(false);
  });

  it("withholds it from a withdrawn device", () => {
    expect(canSync(device({ revoked: true }))).toBe(false);
  });
});

describe("canRevoke", () => {
  it("offers revocation for another live device", () => {
    expect(canRevoke(device())).toBe(true);
  });

  it("withholds it from this node's own device", () => {
    expect(canRevoke(device({ isSelf: true }))).toBe(false);
  });

  it("withholds it from a device already withdrawn", () => {
    expect(canRevoke(device({ revoked: true }))).toBe(false);
  });

  it("withholds it from a device bound nowhere, since the route names a namespace", () => {
    expect(canRevoke(device({ namespaces: [] }))).toBe(false);
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

describe("canWiden", () => {
  it("offers the action for a scoped device", () => {
    expect(canWiden(device({ applications: ["App1"] }))).toBe(true);
  });

  it("withholds it from a device that already reaches every app", () => {
    expect(canWiden(device({ applications: [] }))).toBe(false);
  });

  it("withholds it from this node's own device and a revoked one", () => {
    expect(canWiden(device({ applications: ["App1"], isSelf: true }))).toBe(false);
    expect(canWiden(device({ applications: ["App1"], revoked: true }))).toBe(false);
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
