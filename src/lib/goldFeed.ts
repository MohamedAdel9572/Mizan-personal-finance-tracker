/**
 * Automatic gold price from the internet, fetched by the browser.
 *
 *   gold:  https://api.gold-api.com/price/XAU   (USD per troy ounce, free, no key)
 *   rate:  https://open.er-api.com/v6/latest/USD (USD -> EGP, free, no key, daily)
 *
 * Neither needs a key, so there is nothing secret to protect and no server
 * function is needed. Price per gram for a karat:
 *   spot USD/oz ÷ 31.1034768 g × (karat / 24) × EGP per USD
 * This is the world price converted to EGP; Egyptian shop prices are usually
 * within a few percent of it. A price typed on the Gold page always wins.
 *
 * The last good result is kept in this browser, so a failed call still shows
 * a price (with a warning and its time).
 */
import { Dec } from "../engine/decimal.ts";
import { KARATS, type Karat } from "../engine/gold.ts";

const GOLD_URL = "https://api.gold-api.com/price/XAU";
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const CACHE_KEY = "mizan_gold_feed_v1";
const FRESH_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8000;
const GRAMS_PER_OZ = Dec.of("31.1034768");

export interface GoldFeed {
  spotUsdOz: string;
  usdEgp: string;
  /** when the gold price was last updated by the source (ISO) */
  goldAt: string;
  /** when this browser fetched it (ISO) */
  fetchedAt: string;
  perGram: Record<Karat, string>;
  /** true when the latest call failed and this is the last saved result */
  stale: boolean;
}

export function perGramFor(spotUsdOz: Dec, usdEgp: Dec): Record<Karat, string> {
  const gram24 = spotUsdOz.div(GRAMS_PER_OZ).times(usdEgp);
  const out = {} as Record<Karat, string>;
  for (const k of KARATS) out[k] = gram24.times(k).div(24).round(2).toString();
  return out;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function readCache(): GoldFeed | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as GoldFeed) : null;
  } catch {
    return null;
  }
}

function writeCache(feed: GoldFeed): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(feed));
  } catch {
    // storage full or blocked: we just fetch again next time
  }
}

/** Parse the two API answers; throws if anything looks wrong. */
export function buildFeed(gold: unknown, fx: unknown, now = new Date()): GoldFeed {
  const g = gold as { price?: unknown; updatedAt?: unknown };
  const f = fx as { result?: unknown; rates?: Record<string, unknown> };
  if (typeof g?.price !== "number" || !(g.price > 100 && g.price < 100_000)) throw new Error("Unexpected gold price");
  const egp = f?.rates?.EGP;
  if (f?.result !== "success" || typeof egp !== "number" || !(egp > 1 && egp < 10_000)) throw new Error("Unexpected exchange rate");
  const spot = Dec.of(g.price);
  const rate = Dec.of(egp);
  return {
    spotUsdOz: spot.round(2).toString(),
    usdEgp: rate.round(4).toString(),
    goldAt: typeof g.updatedAt === "string" ? g.updatedAt : now.toISOString(),
    fetchedAt: now.toISOString(),
    perGram: perGramFor(spot, rate),
    stale: false,
  };
}

/** Latest automatic price: fresh cache, else the internet, else the last saved one (stale). */
export async function getGoldFeed(force = false): Promise<GoldFeed | null> {
  const cached = readCache();
  if (!force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < FRESH_MS) return { ...cached, stale: false };
  try {
    const [gold, fx] = await Promise.all([getJson(GOLD_URL), getJson(FX_URL)]);
    const feed = buildFeed(gold, fx);
    writeCache(feed);
    return feed;
  } catch (e) {
    console.warn("gold price fetch failed", e);
    return cached ? { ...cached, stale: true } : null;
  }
}
