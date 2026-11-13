import { describe, expect, it } from "vitest";
import { Dec } from "../decimal.ts";

describe("Dec", () => {
  it("adds without float errors", () => {
    expect(Dec.of("0.1").plus("0.2").toString()).toBe("0.3");
    expect(Dec.of(0.1).plus(0.2).eq("0.3")).toBe(true);
  });

  it("parses strings, commas, negatives and integers", () => {
    expect(Dec.of("1,234,567.89").toFixed(2)).toBe("1234567.89");
    expect(Dec.of("-42").toFixed(2)).toBe("-42.00");
    expect(Dec.of(28000n).toString()).toBe("28000");
    expect(Dec.of(1e-7).toString()).toBe("0.0000001");
  });

  it("rejects garbage", () => {
    expect(() => Dec.of("12abc")).toThrow();
    expect(() => Dec.of(Number.NaN)).toThrow();
    expect(() => Dec.of("")).toThrow();
    expect(Dec.tryOf("abc")).toBeNull();
    expect(Dec.tryOf(null)).toBeNull();
    expect(Dec.tryOf("5")?.toString()).toBe("5");
  });

  it("multiplies and divides exactly to 10 places, rounding half to even", () => {
    expect(Dec.of("100000").times("17").div("1200").toString()).toBe("1416.6666666667");
    expect(Dec.of("1").div("3").toString()).toBe("0.3333333333");
    expect(Dec.of("0.00000000005").toString()).toBe("0"); // half-even: 0.5 units -> 0
    expect(Dec.of("0.00000000015").toString()).toBe("0.0000000002"); // 1.5 units -> 2
    expect(() => Dec.of(1).div(0)).toThrow();
  });

  it("rounds money half away from zero for display", () => {
    expect(Dec.of("2.345").toFixed(2)).toBe("2.35");
    expect(Dec.of("-2.345").toFixed(2)).toBe("-2.35");
    expect(Dec.of("2.344").toFixed(2)).toBe("2.34");
    expect(Dec.of("-0.004").toFixed(2)).toBe("0.00");
    expect(Dec.of("1449.99999").toFixed(0)).toBe("1450");
  });

  it("compares", () => {
    expect(Dec.of("5").gt("4.99")).toBe(true);
    expect(Dec.of("-1").isNegative()).toBe(true);
    expect(Dec.sum(["1.5", "2.5", Dec.of(1)]).toString()).toBe("5");
    expect(Dec.max(Dec.of(1), Dec.of(2)).toString()).toBe("2");
  });

  it("handles large balances", () => {
    expect(Dec.of("99999999999999.99").plus("0.01").toFixed(2)).toBe("100000000000000.00");
  });
});
