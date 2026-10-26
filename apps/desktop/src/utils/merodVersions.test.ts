import { describe, it, expect } from "vitest";
import { formatVersionLabel, runtimeVersion, BUNDLED_VERSION_ID } from "./merodVersions";

describe("formatVersionLabel", () => {
  it("calls the shipped binary the default, and drops build metadata", () => {
    expect(
      formatVersionLabel(BUNDLED_VERSION_ID, "merod 0.11.0-rc.19 (build c2e8ec3) (rustc 1.88.0)")
    ).toBe("default - 0.11.0-rc.19");
  });

  it("says just default when the binary could not be read", () => {
    // get_merod_binary_version returns the literal "unknown" on failure.
    expect(formatVersionLabel(BUNDLED_VERSION_ID, "unknown")).toBe("default");
    expect(formatVersionLabel(BUNDLED_VERSION_ID, "")).toBe("default");
  });

  it("names the bundled binary with the version it actually reports", () => {
    expect(formatVersionLabel(BUNDLED_VERSION_ID, "merod 0.11.0-rc.19")).toBe(
      "default - 0.11.0-rc.19"
    );
  });

  it("falls back when the bundled version is unknown", () => {
    expect(formatVersionLabel(BUNDLED_VERSION_ID, "")).toBe("default");
  });

  it("shows a release tag as-is", () => {
    expect(formatVersionLabel("0.11.0-rc.15", "merod 0.11.0-rc.19")).toBe("0.11.0-rc.15");
  });

  it("shows a local build by its basename, not the whole path", () => {
    expect(
      formatVersionLabel("local:/Users/dev/core/target/release/merod", "merod 0.11.0-rc.19")
    ).toBe("local build");
  });

  it("shows a local build's measured version so a rebuild is visible", () => {
    expect(
      formatVersionLabel(
        "local:/Users/dev/core/target/release/merod",
        "merod 0.11.0-rc.19",
        "merod 0.11.0-rc.20-dev"
      )
    ).toBe("local build - 0.11.0-rc.20-dev");
  });

  it("falls back to plain 'local build' when the measured version is unknown", () => {
    expect(
      formatVersionLabel("local:/Users/dev/core/target/release/merod", "merod 0.11.0-rc.19", null)
    ).toBe("local build");
  });
});

describe("runtimeVersion", () => {
  it("reads the bundled binary's tag", () => {
    expect(runtimeVersion(BUNDLED_VERSION_ID, "merod 0.11.0 (build 055b157)")).toBe("0.11.0");
    expect(runtimeVersion(BUNDLED_VERSION_ID, "unknown")).toBe("");
  });

  it("takes a release id as the version it names", () => {
    expect(runtimeVersion("0.12.0-rc.1", "merod 0.11.0")).toBe("0.12.0-rc.1");
  });

  it("reads a local build from what it measured, or not at all", () => {
    expect(runtimeVersion("local:/core/target/release/merod", "merod 0.11.0", "merod 0.12.0-rc.3")).toBe("0.12.0-rc.3");
    expect(runtimeVersion("local:/core/target/release/merod", "merod 0.11.0")).toBe("");
  });
});
