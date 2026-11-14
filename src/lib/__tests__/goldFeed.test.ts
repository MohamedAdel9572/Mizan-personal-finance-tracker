import { describe, expect, it } from "vitest";
import { adjustFeed, buildFeed, perGramFor } from "../goldFeed.ts";
import { Dec } from "../../engine/decimal.ts";
import { effectivePrices } from "../gold.ts";

describe("automatic gold price", () => {
  it("converts USD/oz to EGP per gram by karat", () => {
    // 3887.60 $/oz at 53.437041 EGP/$ (14 Nov 2026)
    const g = perGramFor(Dec.of("3887.60"), Dec.of("53.437041"));
    expect(g[24]).toBe("6679.06");
    expect(g[21]).toBe("5844.17");
    expect(g[18]).toBe("5009.29");
    expect(g[22]).toBe("6122.47");
    expect(g[14]).toBe("3896.12");
    expect(g[12]).toBe("3339.53");
  });

  it("parses the two API answers and rejects nonsense", () => {
    const f = buildFeed({ price: 3887.600098, updatedAt: "2026-11-14T01:26:10Z" },
      { result: "success", rates: { EGP: 53.437041 } }, new Date("2026-11-14T01:30:00Z"));
    expect(f.perGram[21]).toBe("5844.17");
    expect(f.goldAt).toBe("2026-11-14T01:26:10Z");
    expect(() => buildFeed({ price: "x" }, { result: "success", rates: { EGP: 53 } })).toThrow();
    expect(() => buildFeed({ price: 3887 }, { result: "error" })).toThrow();
  });

  it("your own price wins over the automatic one", () => {
    const feed = { perGram: { 24: "6679.11", 22: "6122.52", 21: "5844.22", 18: "5009.33", 14: "3896.15", 12: "3339.56" } };
    const rows = [{ karat: 21 as const, my_price: "5900.00", my_price_at: "x", fetched_price: null, fetched_at: null, source: null }];
    expect(effectivePrices(rows, feed)[21]).toBe("5900.00");
    expect(effectivePrices([], feed)[21]).toBe("5844.22");
    expect(effectivePrices([], null)[21]).toBeUndefined();
  });

  it("adds the market adjustment to every karat", () => {
    const feed = buildFeed({ price: 3887.6, updatedAt: "2026-11-14T01:00:00Z" }, { result: "success", rates: { EGP: 53.437041 } });
    const adj = adjustFeed(feed, "1.3");
    expect(adj.perGram[21]).toBe("5920.14"); // 5844.17 × 1.013 rounds to 5920.14 (your app showed 5,920)
    expect(adj.perGram[24]).toBe(Dec.of("6679.06").times("1.013").round(2).toString());
    expect(adj.adjustPct).toBe("1.3");
    expect(adjustFeed(feed, "0").perGram[21]).toBe("5844.17");
    expect(adjustFeed(feed, "-2").perGram[21]).toBe(Dec.of("5844.17").times("0.98").round(2).toString());
  });
});
