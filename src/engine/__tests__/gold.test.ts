import { describe, expect, it } from "vitest";
import { valueHolding, valueHoldings, type GoldHolding } from "../gold.ts";

const bar: GoldHolding = { label: "BTC bar", karat: 24, grams: "10", purchasePrice: "40000", purchaseDate: "2026-01-10" };
const ring: GoldHolding = { label: "Ring", karat: 21, grams: "5.5", purchasePrice: "20000", purchaseDate: "2026-03-01" };

describe("gold", () => {
  it("market value, sell value and profit for one holding", () => {
    const v = valueHolding(bar, "4800", "3");
    expect(v.market.toString()).toBe("48000");
    expect(v.sell.toString()).toBe("46560");
    expect(v.profitMarket.toString()).toBe("8000");
    expect(v.profitSell.toString()).toBe("6560");
  });

  it("totals only what is owned on the date and reports missing prices", () => {
    const s = valueHoldings([bar, ring, { ...bar, label: "sold", soldDate: "2026-02-01" }], { 24: "4800" }, "0", "2026-06-30");
    expect(s.holdings).toHaveLength(1);
    expect(s.market.toString()).toBe("48000");
    expect(s.missingPrices).toEqual([21]);
    const before = valueHoldings([bar, ring], { 24: "4800", 21: "4200" }, "0", "2026-02-01");
    expect(before.holdings.map((h) => h.holding.label)).toEqual(["BTC bar"]);
  });

  it("handles fractional grams exactly", () => {
    const s = valueHoldings([ring], { 21: "4200.50" }, "2.5", "2026-06-30");
    expect(s.market.toString()).toBe("23102.75");
    expect(s.sell.toFixed(2)).toBe("22525.18");
  });
});
