import { describe, it, expect, vi } from "vitest";
import type { RunningMerodNode } from "../utils/merod";
import type { HardResetPreview } from "../utils/hardReset";

const wipeClientState = vi.fn().mockResolvedValue(true);
const hardReset = vi.fn();
const previewHardReset = vi.fn();
vi.mock("../utils/hardReset", () => ({
  wipeClientState: (...a: unknown[]) => wipeClientState(...a),
  hardReset: (...a: unknown[]) => hardReset(...a),
  previewHardReset: (...a: unknown[]) => previewHardReset(...a),
}));

import {
  getNukeDirsToDisplay,
  formatNodeToStop,
  nodesToStopWarningText,
  isNukeConfirmDisabled,
  isSoftResetConfirmDisabled,
  runSoftReset,
} from "./Settings";

function node(overrides: Partial<RunningMerodNode> = {}): RunningMerodNode {
  return { pid: 4242, node_name: "default", port: 2428, home_dir: "/Users/alice/.calimero", ...overrides };
}

function preview(overrides: Partial<HardResetPreview> = {}): HardResetPreview {
  return { dirsToDelete: ["/Users/alice/.calimero"], nodesToStop: [], ...overrides };
}

describe("getNukeDirsToDisplay", () => {
  it("falls back to the configured (or default) data dir before the preview loads", () => {
    expect(getNukeDirsToDisplay(null, "~/.calimero")).toEqual(["~/.calimero"]);
  });

  it("shows every directory the preview says will be deleted once it loads", () => {
    const p = preview({ dirsToDelete: ["/Users/alice/.calimero", "/Users/alice/custom-data"] });
    expect(getNukeDirsToDisplay(p, "~/.calimero")).toEqual([
      "/Users/alice/.calimero",
      "/Users/alice/custom-data",
    ]);
  });
});

describe("formatNodeToStop", () => {
  it("formats name, pid and home dir for the confirmation list", () => {
    expect(formatNodeToStop(node({ node_name: "default", pid: 4242, home_dir: "/Users/alice/.calimero" }))).toBe(
      "default (PID 4242) - /Users/alice/.calimero"
    );
  });
});

describe("nodesToStopWarningText", () => {
  it("uses singular wording for exactly one node", () => {
    expect(nodesToStopWarningText(1)).toBe(
      "The following running node will be stopped first, whether or not this app started it:"
    );
  });

  it("uses plural wording for more than one node", () => {
    expect(nodesToStopWarningText(2)).toBe(
      "The following running nodes will be stopped first, whether or not this app started them:"
    );
  });
});

describe("isNukeConfirmDisabled", () => {
  it("is disabled until the preview has loaded, even if the checkbox is already checked", () => {
    expect(isNukeConfirmDisabled(true, false, null)).toBe(true);
  });

  it("is disabled until the checkbox is checked", () => {
    expect(isNukeConfirmDisabled(false, false, preview())).toBe(true);
  });

  it("is disabled while the nuke is in flight", () => {
    expect(isNukeConfirmDisabled(true, true, preview())).toBe(true);
  });

  it("is enabled once confirmed, not in flight, and the preview has loaded", () => {
    expect(isNukeConfirmDisabled(true, false, preview())).toBe(false);
  });
});

describe("isSoftResetConfirmDisabled", () => {
  it("is disabled until the checkbox is checked", () => {
    expect(isSoftResetConfirmDisabled(false, false)).toBe(true);
  });

  it("is disabled while resetting", () => {
    expect(isSoftResetConfirmDisabled(true, true)).toBe(true);
  });

  it("is enabled once confirmed and not in flight", () => {
    expect(isSoftResetConfirmDisabled(true, false)).toBe(false);
  });
});

describe("runSoftReset", () => {
  it("wipes client state but never stops a node or deletes data", async () => {
    await runSoftReset();
    expect(wipeClientState).toHaveBeenCalledTimes(1);
    expect(wipeClientState).toHaveBeenCalledWith();
    expect(hardReset).not.toHaveBeenCalled();
  });
});
