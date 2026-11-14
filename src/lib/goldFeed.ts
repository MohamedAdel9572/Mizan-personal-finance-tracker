/**
 * Automatic gold price from the internet, fetched by the browser (no keys,
 * nothing secret, no server function).
 *
 * 1. Egyptian shop price (preferred): Daleelak's free feed of licensed
 *    Egyptian gold dealers, https://getdaleelak.com/api/v1/feed.json
 *    ("Free to use. A link back to Daleelak is appreciated.", CORS open).
 *    We use eDahab's BUYING price (what a shop pays you today, no workmanship),
 *    the same number the eDahab app values your gold with. If eDahab is
 *    missing for a karat we use the average buying price of the other dealers.
 *    The feed has 24K, 21K and 18K; 22K comes from 24K and 14K/12K from 18K
 *    by purity.
 * 2. World price (fallback): https://api.gold-api.com/price/XAU (USD/oz) ×
 *    https://open.er-api.com/v6/latest/USD (EGP rate):
 *      spot USD/oz ÷ 31.1034768 g × (karat / 24) × EGP per USD
 *    plus the user's "Match your shop" % from Settings.
 *
 * A price typed on the Gold page always wins. The last good result is kept in
 * this browser, so a failed call still shows a price (with a warning).
 */
import { Dec } from "../engine/decimal.ts";
import { KARATS, type Karat } from "../engine/gold.ts";

const GOLD_URL = "https://api.gold-api.com/price/XAU";
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const LOCAL_URL = (slug: string) => `https://getdaleelak.com/api/v1/feed.json?asset=${slug}`;
const LOCAL_SLUGS = { 24: "gold-24k", 21: "gold-21k", 18: "gold-18k" } as const;
export const PREFERRED_SELLER = "eDahab";
const CACHE_KEY = "mizan_gold_feed_v2";
const FRESH_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8000;
const GRAMS_PER_OZ = Dec.of("31.1034768");

export interface GoldFeed {
  /** "local" = Egyptian shop buying price, "world" = world price × EGP rate */
  source: "local" | "world";
  /** who the local price comes from, e.g. "eDahab" or "average of 3 dealers" */
  sourceName?: string;
  spotUsdOz: string;
  usdEgp: string;
  /** when the gold price was last updated by the source (ISO) */
  goldAt: string;
  /** when this browser fetched it (ISO) */
  fetchedAt: string;
  perGram: Record<Karat, string>;
  /** true when the latest call failed and this is the last saved result */
  stale: boolean;
  /** % the user added to match local shop prices (0 = world price × bank rate) */
  adjustPct?: string;
}

/** Applies the user's market adjustment (e.g. +1.3) to every karat. Only for the world-price fallback:
 *  the Egyptian shop price is already the shop price. */
export function adjustFeed(feed: GoldFeed, pct: string): GoldFeed {
  const p = Dec.of(pct || "0");
  if (feed.source === "local" || p.isZero()) return { ...feed, adjustPct: "0" };
  const factor = Dec.of(1).plus(p.div(100));
  const perGram = {} as Record<Karat, string>;
  for (const k of KARATS) perGram[k] = Dec.of(feed.perGram[k]).times(factor).round(2).toString();
  return { ...feed, perGram, adjustPct: p.toString() };
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
    source: "world",
    spotUsdOz: spot.round(2).toString(),
    usdEgp: rate.round(4).toString(),
    goldAt: typeof g.updatedAt === "string" ? g.updatedAt : now.toISOString(),
    fetchedAt: now.toISOString(),
    perGram: perGramFor(spot, rate),
    stale: false,
  };
}

interface LocalSeller { seller?: unknown; buy?: unknown }
interface LocalAsset { id?: unknown; unit?: unknown; observedAt?: unknown; sellers?: LocalSeller[] }

/** Buying price per gram for one karat from a Daleelak answer: eDahab, else the dealers' average. */
export function localBuyPrice(answer: unknown, karat: 24 | 21 | 18): { price: Dec; seller: string; at: string | null } {
  const assets = (answer as { assets?: LocalAsset[] })?.assets;
  const asset = Array.isArray(assets) ? assets.find((a) => a.id === `GOLD${karat}K-EGP`) : undefined;
  if (!asset || asset.unit !== "EGP/g" || !Array.isArray(asset.sellers)) throw new Error(`No ${karat}K price in the Egyptian feed`);
  const ok = asset.sellers.filter((s): s is { seller: string; buy: number } =>
    typeof s.seller === "string" && typeof s.buy === "number" && s.buy > 100 && s.buy < 1_000_000);
  if (!ok.length) throw new Error(`No ${karat}K dealer prices`);
  const pick = ok.find((s) => s.seller === PREFERRED_SELLER);
  const at = typeof asset.observedAt === "string" ? asset.observedAt : null;
  if (pick) return { price: Dec.of(pick.buy), seller: PREFERRED_SELLER, at };
  const avg = Dec.sum(ok.map((s) => Dec.of(s.buy))).div(ok.length);
  return { price: avg.round(2), seller: `average of ${ok.length} dealers`, at };
}

/** Egyptian shop prices for every karat; 22K from 24K and 14K/12K from 18K by purity. */
export function buildLocalFeed(answers: { 24: unknown; 21: unknown; 18: unknown }, world: GoldFeed | null, now = new Date()): GoldFeed {
  const k24 = localBuyPrice(answers[24], 24);
  const k21 = localBuyPrice(answers[21], 21);
  const k18 = localBuyPrice(answers[18], 18);
  const perGram: Record<Karat, string> = {
    24: k24.price.round(2).toString(),
    22: k24.price.times(22).div(24).round(2).toString(),
    21: k21.price.round(2).toString(),
    18: k18.price.round(2).toString(),
    14: k18.price.times(14).div(18).round(2).toString(),
    12: k18.price.times(12).div(18).round(2).toString(),
  };
  const names = [...new Set([k24.seller, k21.seller, k18.seller])];
  return {
    source: "local",
    sourceName: names.length === 1 ? names[0] : names.join(" / "),
    spotUsdOz: world?.spotUsdOz ?? "",
    usdEgp: world?.usdEgp ?? "",
    goldAt: k21.at ?? now.toISOString(),
    fetchedAt: now.toISOString(),
    perGram,
    stale: false,
  };
}

async function worldFeed(): Promise<GoldFeed> {
  const [gold, fx] = await Promise.all([getJson(GOLD_URL), getJson(FX_URL)]);
  return buildFeed(gold, fx);
}

/** Latest automatic price: fresh cache, else the internet (Egyptian shops, else world), else the last saved one (stale). */
export async function getGoldFeed(force = false): Promise<GoldFeed | null> {
  const cached = readCache();
  if (!force && cached && Date.now() - new Date(cached.fetchedAt).getTime() < FRESH_MS) return { ...cached, stale: false };
  const [local, world] = await Promise.allSettled([
    Promise.all([getJson(LOCAL_URL(LOCAL_SLUGS[24])), getJson(LOCAL_URL(LOCAL_SLUGS[21])), getJson(LOCAL_URL(LOCAL_SLUGS[18]))]),
    worldFeed(),
  ]);
  const w = world.status === "fulfilled" ? world.value : null;
  try {
    if (local.status !== "fulfilled") throw local.reason;
    const [a24, a21, a18] = local.value;
    const feed = buildLocalFeed({ 24: a24, 21: a21, 18: a18 }, w);
    writeCache(feed);
    return feed;
  } catch (e) {
    console.warn("Egyptian gold price unavailable, using the world price", e);
  }
  if (w) {
    // keep a saved shop price if it is recent (under a day) rather than dropping to the world price
    if (cached?.source === "local" && Date.now() - new Date(cached.fetchedAt).getTime() < 24 * 3600 * 1000) return { ...cached, stale: true };
    writeCache(w);
    return w;
  }
  console.warn("gold price fetch failed");
  return cached ? { ...cached, stale: true } : null;
}
