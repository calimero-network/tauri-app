import { describe, expect, it } from "vitest";
import { appLabel } from "./frontend";

describe("appLabel", () => {
  it("is the id's 32 bytes as 52 unpadded base32 characters", () => {
    expect(appLabel("00".repeat(32))).toBe("a".repeat(52));
    expect(appLabel("ff".repeat(32))).toBe("7".repeat(51) + "q");
    expect(appLabel("62597cc99948fb004a3cfea24f3703a08e9aaadbc4fa337e2fd04abec1b4f9bf")).toBe(
      "mjmxzsmzjd5qasr472re6nyduchjvkw3yt5dg7rp2bfl5qnu7g7q",
    );
  });
});
