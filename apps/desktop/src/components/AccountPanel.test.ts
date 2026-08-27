import { describe, it, expect, vi } from "vitest";
import type { AccountDevice } from "../lib/device-link";

vi.mock("../lib/device-link", () => ({
  listAccountDevices: vi.fn(),
  relinkDevice: vi.fn(),
  revokeDevice: vi.fn(),
}));

import { canRevoke, canSync, deviceScope, relinkSummary } from "./AccountPanel";

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
