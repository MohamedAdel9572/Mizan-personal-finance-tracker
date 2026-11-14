import { Dec } from "./decimal.ts";
import type { Money } from "./types.ts";

export type Karat = 24 | 22 | 21 | 18 | 14 | 12;

/** Karats sold in Egypt, purest first. */
export const KARATS: readonly Karat[] = [24, 22, 21, 18, 14, 12];

export interface GoldHolding {
  label: string;
  karat: Karat;
  grams: Money;
  /** total paid in EGP */
  purchasePrice: Money;
  purchaseDate: string; // YYYY-MM-DD
  soldDate?: string | null;
}

export interface HoldingValue {
  holding: GoldHolding;
  pricePerGram: Dec;
  /** grams x price */
  market: Dec;
  /** market x (1 - spread%) : what a shop would pay you */
  sell: Dec;
  profitMarket: Dec;
  profitSell: Dec;
}

export function valueHolding(h: GoldHolding, pricePerGram: Money | Dec, sellSpreadPct: Money | Dec): HoldingValue {
  const price = Dec.of(pricePerGram);
  const market = Dec.of(h.grams).times(price);
  const sell = market.times(Dec.of(100).minus(sellSpreadPct)).div(100);
  const cost = Dec.of(h.purchasePrice);
  return { holding: h, pricePerGram: price, market, sell, profitMarket: market.minus(cost), profitSell: sell.minus(cost) };
}

export interface GoldSummary {
  holdings: HoldingValue[];
  market: Dec;
  sell: Dec;
  cost: Dec;
  profitMarket: Dec;
  profitSell: Dec;
  /** karats held but with no price available */
  missingPrices: Karat[];
}

/**
 * Value of the holdings owned on `asOf` (bought on/before, not sold by then).
 * prices: price per gram by karat (override already applied by the caller).
 */
export function valueHoldings(
  holdings: readonly GoldHolding[],
  prices: Partial<Record<Karat, Money | Dec>>,
  sellSpreadPct: Money | Dec,
  asOf: string,
): GoldSummary {
  const values: HoldingValue[] = [];
  const missing = new Set<Karat>();
  for (const h of holdings) {
    if (h.purchaseDate > asOf || (h.soldDate && h.soldDate <= asOf)) continue;
    const p = prices[h.karat];
    if (p == null) {
      missing.add(h.karat);
      continue;
    }
    values.push(valueHolding(h, p, sellSpreadPct));
  }
  const market = Dec.sum(values.map((v) => v.market));
  const sell = Dec.sum(values.map((v) => v.sell));
  const cost = Dec.sum(values.map((v) => v.holding.purchasePrice));
  return {
    holdings: values,
    market,
    sell,
    cost,
    profitMarket: market.minus(cost),
    profitSell: sell.minus(cost),
    missingPrices: [...missing].sort((a, b) => b - a),
  };
}
