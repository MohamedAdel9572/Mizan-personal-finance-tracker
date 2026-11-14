import { describe, expect, it } from "vitest";
import { adjustFeed, buildFeed, buildLocalFeed, localBuyPrice, perGramFor } from "../goldFeed.ts";
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

  // Daleelak answers of 14 Nov 2026 (trimmed): eDahab buy 6,766 / 5,920 / 5,074
  const at = "2026-11-14T11:57:00.000Z";
  const asset = (k: number, sellers: { seller: string; buy: number }[]) => ({ assets: [{ id: `GOLD${k}K-EGP`, unit: "EGP/g", observedAt: at, sellers }] });
  const d24 = asset(24, [{ seller: "BTC", buy: 6749.71 }, { seller: "eDahab", buy: 6766 }, { seller: "iSagha", buy: 6782.75 }]);
  const d21 = asset(21, [{ seller: "BTC", buy: 5906.7 }, { seller: "eDahab", buy: 5920 }, { seller: "Goldady", buy: 5926.5 }, { seller: "iSagha", buy: 5935 }]);
  const d18 = asset(18, [{ seller: "eDahab", buy: 5074 }, { seller: "iSagha", buy: 5087.25 }]);

  it("uses the Egyptian shop buying price from eDahab", () => {
    const f = buildLocalFeed({ 24: d24, 21: d21, 18: d18 }, null, new Date(at));
    expect(f.source).toBe("local");
    expect(f.sourceName).toBe("eDahab");
    expect(f.perGram[21]).toBe("5920");
    expect(f.perGram[24]).toBe("6766");
    expect(f.perGram[18]).toBe("5074");
    expect(f.perGram[22]).toBe("6202.17"); // 6766 × 22/24
    expect(f.perGram[14]).toBe("3946.44"); // 5074 × 14/18
    expect(f.perGram[12]).toBe("3382.67"); // 5074 × 12/18
    // 17.5 g of 21K = 103,600, as in the eDahab app
    expect(Dec.of(f.perGram[21]).times("17.5").toString()).toBe("103600");
  });

  it("falls back to the dealers' average when eDahab is missing, and rejects bad answers", () => {
    const noEdahab = asset(21, [{ seller: "BTC", buy: 5906.7 }, { seller: "iSagha", buy: 5935 }]);
    const p = localBuyPrice(noEdahab, 21);
    expect(p.price.toString()).toBe("5920.85");
    expect(p.seller).toBe("average of 2 dealers");
    expect(() => localBuyPrice({ assets: [] }, 21)).toThrow();
    expect(() => localBuyPrice(asset(21, [{ seller: "x", buy: -1 }]), 21)).toThrow();
    expect(() => localBuyPrice(null, 21)).toThrow();
  });

  it("does not add the world-price % to the shop price", () => {
    const f = buildLocalFeed({ 24: d24, 21: d21, 18: d18 }, null);
    expect(adjustFeed(f, "1.3").perGram[21]).toBe("5920");
  });
});
