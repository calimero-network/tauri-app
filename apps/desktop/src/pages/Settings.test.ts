import { describe, it, expect, vi } from "vitest";
import type { HardResetPreview } from "../utils/hardReset";

vi.mock("../utils/hardReset", () => ({
  wipeClientState: vi.fn(),
  hardReset: vi.fn(),
  previewHardReset: vi.fn(),
}));

import { nukePreviewStatus, canConfirmNuke } from "./Settings";

const PREVIEW: HardResetPreview = {
  dirsToDelete: ["~/.calimero"],
  nodesToStop: [{ pid: 42, node_name: "default", port: 2528, home_dir: "/Users/dev/.calimero" }],
};

describe("nukePreviewStatus", () => {
  it("is loading while the check is still in flight", () => {
    expect(nukePreviewStatus(null, "")).toEqual({ kind: "loading" });
  });

  it("reports the failure so the dialog can explain it and offer a retry", () => {
    expect(nukePreviewStatus(null, "home dir not found")).toEqual({
      kind: "failed",
      message: "home dir not found",
    });
  });

  it("lets a failure outrank an earlier preview, rather than claim nothing is running", () => {
    expect(nukePreviewStatus(PREVIEW, "home dir not found").kind).toBe("failed");
  });

  it("is ready with the nodes that would be stopped", () => {
    expect(nukePreviewStatus(PREVIEW, "")).toEqual({
      kind: "ready",
      nodesToStop: PREVIEW.nodesToStop,
    });
  });
});

describe("canConfirmNuke", () => {
  it("allows the delete once the preview is in and the box is ticked", () => {
    expect(canConfirmNuke({ kind: "ready", nodesToStop: [] }, true, false)).toBe(true);
  });

  it("blocks the delete while the check is still running", () => {
    expect(canConfirmNuke({ kind: "loading" }, true, false)).toBe(false);
  });

  it("blocks the delete when the check failed, however often the user retries", () => {
    // Without the preview we cannot say which nodes would be stopped, so deleting
    // could pull the store out from under a live writer.
    expect(canConfirmNuke({ kind: "failed", message: "boom" }, true, false)).toBe(false);
  });

  it("blocks the delete until the box is ticked", () => {
    expect(canConfirmNuke({ kind: "ready", nodesToStop: [] }, false, false)).toBe(false);
  });

  it("blocks a second delete while one is already running", () => {
    expect(canConfirmNuke({ kind: "ready", nodesToStop: [] }, true, true)).toBe(false);
  });
});
