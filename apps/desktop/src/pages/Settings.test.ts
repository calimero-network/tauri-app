import { describe, it, expect, vi } from "vitest";

const wipeClientState = vi.fn().mockResolvedValue(true);
const hardReset = vi.fn();
const previewHardReset = vi.fn();
vi.mock("../utils/hardReset", () => ({
  wipeClientState: (...a: unknown[]) => wipeClientState(...a),
  hardReset: (...a: unknown[]) => hardReset(...a),
  previewHardReset: (...a: unknown[]) => previewHardReset(...a),
}));

import { runSoftReset } from "./Settings";

describe("runSoftReset", () => {
  it("wipes client state but never stops a node or deletes data", async () => {
    await runSoftReset();
    expect(wipeClientState).toHaveBeenCalledTimes(1);
    expect(wipeClientState).toHaveBeenCalledWith();
    expect(hardReset).not.toHaveBeenCalled();
  });
});
