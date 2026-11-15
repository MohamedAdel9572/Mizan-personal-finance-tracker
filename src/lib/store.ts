/**
 * Loads everything a signed-in user needs in two RPC calls and builds the
 * engine objects once. Screens read from here and call reload() after saving.
 */
import { buildActuals } from "../engine/actuals.ts";
import { compareAll, type MonthComparison } from "../engine/compare.ts";
import { PlanTimeline, versionFromRow, type PlanVersionRow } from "../engine/plan.ts";
import type { ActualMonth, ActualsInput, Checkin, PlanVersion } from "../engine/types.ts";
import type { Goal } from "../engine/goal.ts";
import type { Api } from "./api.ts";
import { Dec } from "../engine/decimal.ts";
import { valueHoldings } from "../engine/gold.ts";
import { effectivePrices, toHoldings, type HoldingRow, type PriceRow } from "./gold.ts";
import { adjustFeed, getGoldFeed, type GoldFeed } from "./goldFeed.ts";
import type { CardsData } from "./cards.ts";

/** The plan line that means "my gold" (English or Arabic name). */
export function isGoldLine(name: string): boolean {
  return /gold|ذهب/i.test(name);
}

export interface Profile {
  id: string;
  full_name: string;
  mobile: string;
  created_at: string;
}

export interface VersionInfo {
  id: number;
  /** what the screens show: the Gold asset line follows your real gold value (see goldAuto) */
  version: PlanVersion;
  /** exactly as saved; the plan editor and the import comparison use this */
  rawVersion: PlanVersion;
  note: string;
  createdAt: string;
}

export interface UnplannedRow {
  id: number;
  month: string;
  kind: "income" | "expense";
  name: string;
  amount: string;
  note: string;
}

interface ActualsRow {
  checkins: { month: string; savings_balance: string | null; note: string; gold_value?: string | null }[];
  entries: { month: string; item_key: string; amount: string; note: string }[];
  unplanned: UnplannedRow[];
}

export interface AppData {
  profile: Profile;
  /** newest first */
  versions: VersionInfo[];
  timeline: PlanTimeline | null;
  checkins: (Checkin & { note: string })[];
  /** month -> item_key -> amount */
  entries: Map<string, Map<string, string>>;
  unplanned: UnplannedRow[];
  actuals: ActualMonth[];
  comparisons: MonthComparison[];
  /** gold at today's price, when every karat you own has a price */
  goldValue: Dec | null;
  goldFeed: GoldFeed | null;
  /** true when the plan's Gold line is replaced by the value of your gold pieces */
  goldAuto: boolean;
  /** gold value per logged month: saved when you logged it, else today's value */
  goldByMonth: Map<string, Dec>;
  /** value of the pieces owned at the end of a month, at today's price (null if a price is missing) */
  goldValueAt: (month: string) => Dec | null;
  goal: Goal | null;
  settings: Settings;
  /** cards, their entries and which plan lines they pay (empty before migration 016/017) */
  cards: CardsData;
}

export interface Settings {
  /** "slightly behind" band for the yellow dot, in % of the planned amount */
  warnPct: string;
  /** % added to the automatic gold price to match local shops */
  goldAdjustPct: string;
}

export async function loadProfile(api: Api): Promise<Profile | null> {
  const rows = await api.rpc<Profile[]>("app_me");
  return rows[0] ?? null;
}

export async function loadData(api: Api, profile: Profile): Promise<AppData> {
  const [versionRows, actualRows, goldRows, priceRows, goalRow, settingsRow, cardsRow] = await Promise.all([
    api.rpc<(PlanVersionRow & { id: number; note: string; created_at: string })[]>("get_plan_versions"),
    api.rpc<ActualsRow>("get_actuals"),
    api.rpc<HoldingRow[]>("get_gold_holdings").catch(() => [] as HoldingRow[]),
    api.rpc<PriceRow[]>("get_gold_prices").catch(() => [] as PriceRow[]),
    api.rpc<{ target_amount: string; target_month: string; monthly_savings_target: string | null } | null>("get_goal").catch(() => null),
    api.rpc<{ warn_threshold_pct: string; gold_adjust_pct: string } | null>("get_settings").catch(() => null),
    api.rpc<CardsData | null>("get_cards").catch(() => null),
  ]);
  const cards: CardsData = { cards: cardsRow?.cards ?? [], txns: cardsRow?.txns ?? [], links: cardsRow?.links ?? [] };
  const settings: Settings = { warnPct: settingsRow?.warn_threshold_pct ?? "5", goldAdjustPct: settingsRow?.gold_adjust_pct ?? "0" };
  const owned = goldRows.filter((g) => !g.sold_date);
  // only ask the internet when there is gold to value
  const rawFeed: GoldFeed | null = owned.length ? await getGoldFeed().catch(() => null) : null;
  const feed = rawFeed ? adjustFeed(rawFeed, settings.goldAdjustPct) : null;

  // Gold value now (today's price) and at any month end
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const eff = effectivePrices(priceRows, feed);
  const allHoldings = toHoldings(goldRows);
  const goldValueAt = (month: string): Dec | null => {
    if (!goldRows.length) return null;
    const [y, m] = month.split("-").map(Number) as [number, number];
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const s = valueHoldings(allHoldings, eff, "0", end < todayIso ? end : todayIso);
    return s.missingPrices.length ? null : s.market;
  };
  const gold = owned.length ? valueHoldings(toHoldings(owned), eff, "0", todayIso) : null;
  const goldValue = gold && gold.missingPrices.length === 0 ? gold.market : null;
  const goldAuto = goldValue !== null;

  // The plan's Gold asset line shows today's gold value instead of a typed number
  const withGold = (v: PlanVersion): PlanVersion => !goldAuto ? v : {
    ...v,
    items: v.items.map((it) => it.kind === "asset" && isGoldLine(it.name)
      ? { ...it, recurrence: "recurring" as const, amounts: [{ month: it.start, amount: goldValue!.toString() }] }
      : it),
  };
  const versions: VersionInfo[] = versionRows.map((r) => {
    const raw = versionFromRow(r);
    return { id: r.id, version: withGold(raw), rawVersion: raw, note: r.note, createdAt: r.created_at };
  });
  const timeline = versions.length ? new PlanTimeline(versions.map((v) => v.version)) : null;

  const entries = new Map<string, Map<string, string>>();
  for (const e of actualRows.entries) {
    const m = entries.get(e.month) ?? new Map<string, string>();
    m.set(e.item_key, e.amount);
    entries.set(e.month, m);
  }

  // Logged months: gold saved with the check-in (the price of that day), else today's value
  const assetValues: Record<string, string> = {};
  const goldByMonth = new Map<string, Dec>();
  if (goldAuto && timeline) {
    for (const c of actualRows.checkins) {
      const g = c.gold_value ? Dec.of(c.gold_value) : goldValue!;
      const planned = timeline.planned(c.month);
      const version = timeline.versionFor(c.month);
      if (!planned || !version) continue;
      let other = Dec.ZERO;
      for (const item of version.items) {
        if (item.kind === "asset" && !isGoldLine(item.name)) other = other.plus(planned.lines.get(item.key) ?? Dec.ZERO);
      }
      goldByMonth.set(c.month, g);
      assetValues[c.month] = g.plus(other).toString();
    }
  }

  const input: ActualsInput = {
    assetValues,
    checkins: actualRows.checkins.map((c) => ({ month: c.month, savingsBalance: c.savings_balance })),
    entries: actualRows.entries.map((e) => ({ month: e.month, itemKey: e.item_key, amount: e.amount })),
    unplanned: actualRows.unplanned.map((u) => ({ month: u.month, kind: u.kind, name: u.name, amount: u.amount })),
  };
  const actuals = timeline ? buildActuals(timeline, input) : [];
  const comparisons = timeline ? compareAll(timeline, actuals) : [];

  return {
    profile,
    versions,
    timeline,
    checkins: actualRows.checkins.map((c) => ({ month: c.month, savingsBalance: c.savings_balance, note: c.note })),
    entries,
    unplanned: actualRows.unplanned,
    actuals,
    comparisons,
    goldValue,
    goldFeed: feed,
    goldAuto,
    goldByMonth,
    goldValueAt,
    settings,
    cards,
    goal: goalRow ? { targetAmount: goalRow.target_amount, targetMonth: goalRow.target_month, monthlySavingsTarget: goalRow.monthly_savings_target } : null,
  };
}
