import { describe, expect, it } from "vitest";
import { describeBytes, formatBytes, parseUsage, sumUsage, usageFor } from "./diskUsage";

const row = (namespaceId: string, total: number) => ({
  namespaceId,
  contextCount: 1,
  memberCount: 1,
  subgroupCount: 0,
  bytes: { state: total - 6, privateState: 1, delta: 2, governance: 3, total },
});

describe("parseUsage", () => {
  it("reads core's bare body and a data-enveloped one alike", () => {
    const bare = parseUsage({ namespaces: [row("AB", 100)] });
    const wrapped = parseUsage({ data: { namespaces: [row("ab", 100)] } });
    expect(bare.get("ab")?.total).toBe(100);
    expect(wrapped.get("ab")).toEqual(bare.get("ab"));
  });

  it("drops a row with a partial or negative breakdown rather than half-reporting it", () => {
    const usage = parseUsage({
      namespaces: [
        { namespaceId: "aa", bytes: { state: 1, total: 1 } },
        { namespaceId: "bb", bytes: { state: -1, privateState: 0, delta: 0, governance: 0, total: 0 } },
        row("cc", 10),
      ],
    });
    expect([...usage.keys()]).toEqual(["cc"]);
  });

  it("answers an empty map for anything that is not a usage body", () => {
    for (const junk of [null, undefined, "x", 42, {}, { namespaces: "nope" }]) {
      expect(parseUsage(junk).size).toBe(0);
    }
  });
});

describe("sumUsage", () => {
  const usage = parseUsage({ namespaces: [row("aa", 100), row("bb", 50)] });

  it("sums the namespaces asked about, matching ids case-insensitively", () => {
    expect(sumUsage(usage, ["AA", "bb", "zz"])).toBe(150);
    expect(usageFor(usage, "AA")?.total).toBe(100);
  });

  it("is null, not zero, when none of them is reported", () => {
    expect(sumUsage(usage, ["zz"])).toBeNull();
    expect(sumUsage(null, ["aa"])).toBeNull();
    expect(sumUsage(usage, [])).toBeNull();
  });
});

describe("formatBytes", () => {
  it("uses decimal units and keeps a bare zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_000)).toBe("1 KB");
    expect(formatBytes(1_234_567)).toBe("1.23 MB");
    expect(formatBytes(12_345_678_901)).toBe("12.3 GB");
  });
});

describe("describeBytes", () => {
  it("names every column and the shared data that is excluded", () => {
    const text = describeBytes(parseUsage({ namespaces: [row("aa", 2_000)] }).get("aa")!);
    expect(text).toContain("2 KB");
    expect(text).toContain("History");
    expect(text).toContain("not counted");
  });
});
