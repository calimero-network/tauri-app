import { describe, expect, it } from "vitest";
import { resolveLogTimeRange, toDateTimeLocal } from "./logTimeRange";

const NOW = new Date("2026-08-11T10:00:00Z").getTime();

describe("resolveLogTimeRange", () => {
  it("leaves the tail view unbounded", () => {
    expect(resolveLogTimeRange({ kind: "tail" }, NOW)).toBeNull();
  });

  it("resolves a relative range against now", () => {
    expect(resolveLogTimeRange({ kind: "relative", minutes: 60 }, NOW)).toEqual({
      fromMs: NOW - 3_600_000,
    });
  });

  it("reads custom bounds as local time and includes the whole end minute", () => {
    const from = toDateTimeLocal(NOW);
    const to = toDateTimeLocal(NOW + 5 * 60_000);
    expect(resolveLogTimeRange({ kind: "custom", from, to }, NOW)).toEqual({
      fromMs: NOW,
      toMs: NOW + 5 * 60_000 + 59_999,
    });
  });

  it("allows an open-ended custom range", () => {
    const from = toDateTimeLocal(NOW);
    expect(resolveLogTimeRange({ kind: "custom", from, to: "" }, NOW)).toEqual({
      fromMs: NOW,
      toMs: undefined,
    });
  });

  it("rejects an empty or inverted custom range", () => {
    expect(() => resolveLogTimeRange({ kind: "custom", from: "", to: "" }, NOW)).toThrow(
      /start or end/
    );
    const later = toDateTimeLocal(NOW + 60 * 60_000);
    const earlier = toDateTimeLocal(NOW);
    expect(() =>
      resolveLogTimeRange({ kind: "custom", from: later, to: earlier }, NOW)
    ).toThrow(/after its end/);
  });
});

describe("toDateTimeLocal", () => {
  it("round-trips through Date at minute precision", () => {
    expect(new Date(toDateTimeLocal(NOW)).getTime()).toBe(NOW);
  });
});
