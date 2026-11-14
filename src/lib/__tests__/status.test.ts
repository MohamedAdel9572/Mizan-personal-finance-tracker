import { describe, expect, it } from "vitest";
import { Dec } from "../../engine/decimal.ts";
import { statusOf } from "../../ui/plan.ts";

describe("plan colours", () => {
  // Car planned 8,000: paying more hurts savings (negative effect)
  it("uses the default 5% band", () => {
    expect(statusOf(Dec.of("0"), Dec.of("8000"))).toBe("good");
    expect(statusOf(Dec.of("200"), Dec.of("8000"))).toBe("good");
    expect(statusOf(Dec.of("-300"), Dec.of("8000"))).toBe("warn");
    expect(statusOf(Dec.of("-400"), Dec.of("8000"))).toBe("warn");
    expect(statusOf(Dec.of("-500"), Dec.of("8000"))).toBe("bad");
  });
  it("follows the limit from Settings", () => {
    expect(statusOf(Dec.of("-500"), Dec.of("8000"), "10")).toBe("warn");
    expect(statusOf(Dec.of("-900"), Dec.of("8000"), "10")).toBe("bad");
    expect(statusOf(Dec.of("-1"), Dec.of("8000"), "0")).toBe("bad");
  });
});
