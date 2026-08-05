import { describe, it, expect } from "vitest";
import { formatVersionLabel, BUNDLED_VERSION_ID } from "./merodVersions";

describe("formatVersionLabel", () => {
  it("names the bundled binary with the version it actually reports", () => {
    expect(formatVersionLabel(BUNDLED_VERSION_ID, "merod 0.11.0-rc.19")).toBe(
      "bundled - 0.11.0-rc.19"
    );
  });

  it("falls back when the bundled version is unknown", () => {
    expect(formatVersionLabel(BUNDLED_VERSION_ID, "")).toBe("bundled");
  });

  it("shows a release tag as-is", () => {
    expect(formatVersionLabel("0.11.0-rc.15", "merod 0.11.0-rc.19")).toBe("0.11.0-rc.15");
  });

  it("shows a local build by its basename, not the whole path", () => {
    expect(
      formatVersionLabel("local:/Users/dev/core/target/release/merod", "merod 0.11.0-rc.19")
    ).toBe("local build");
  });
});
