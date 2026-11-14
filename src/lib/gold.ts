// Gold data from the database, shared by the Gold screen and the data store.
import type { GoldHolding, Karat } from "../engine/gold.ts";

export interface HoldingRow { id: number; label: string; karat: number; grams: string; purchase_price: string; purchase_date: string; sold_date: string | null }
export interface PriceRow { karat: Karat; my_price: string | null; my_price_at: string | null; fetched_price: string | null; fetched_at: string | null; source: string | null }

/** Your own price wins; then the automatic internet price; then a price stored in the database. */
export function effectivePrices(prices: PriceRow[], feed?: { perGram: Record<Karat, string> } | null): Partial<Record<Karat, string>> {
  const out: Partial<Record<Karat, string>> = {};
  for (const k of [24, 21, 18] as Karat[]) {
    const p = prices.find((x) => x.karat === k);
    const v = p?.my_price ?? feed?.perGram[k] ?? p?.fetched_price;
    if (v) out[k] = v;
  }
  return out;
}

export function toHoldings(rows: HoldingRow[]): GoldHolding[] {
  return rows.map((r) => ({
    label: r.label, karat: r.karat as Karat, grams: r.grams, purchasePrice: r.purchase_price,
    purchaseDate: r.purchase_date, soldDate: r.sold_date,
  }));
}

