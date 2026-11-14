/**
 * Loads everything a signed-in user needs in two RPC calls and builds the
 * engine objects once. Screens read from here and call reload() after saving.
 */
import { buildActuals } from "../engine/actuals.ts";
import { compareAll, type MonthComparison } from "../engine/compare.ts";
import { PlanTimeline, versionFromRow, type PlanVersionRow } from "../engine/plan.ts";
import type { ActualMonth, ActualsInput, Checkin, PlanVersion } from "../engine/types.ts";
import type { Api } from "./api.ts";
import { Dec } from "../engine/decimal.ts";
import { valueHoldings } from "../engine/gold.ts";
import { effectivePrices, toHoldings, type HoldingRow, type PriceRow } from "./gold.ts";
import { getGoldFeed, type GoldFeed } from "./goldFeed.ts";

export interface Profile {
  id: string;
  full_name: string;
  mobile: string;
  created_at: string;
}

export interface VersionInfo {
  id: number;
  version: PlanVersion;
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
  checkins: { month: string; savings_balance: string | null; note: string }[];
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
}

export async function loadProfile(api: Api): Promise<Profile | null> {
  const rows = await api.rpc<Profile[]>("app_me");
  return rows[0] ?? null;
}

export async function loadData(api: Api, profile: Profile): Promise<AppData> {
  const [versionRows, actualRows, goldRows, priceRows] = await Promise.all([
    api.rpc<(PlanVersionRow & { id: number; note: string; created_at: string })[]>("get_plan_versions"),
    api.rpc<ActualsRow>("get_actuals"),
    api.rpc<HoldingRow[]>("get_gold_holdings").catch(() => [] as HoldingRow[]),
    api.rpc<PriceRow[]>("get_gold_prices").catch(() => [] as PriceRow[]),
  ]);
  const owned = goldRows.filter((g) => !g.sold_date);
  // only ask the internet when there is gold to value
  const feed: GoldFeed | null = owned.length ? await getGoldFeed().catch(() => null) : null;

  const versions: VersionInfo[] = versionRows.map((r) => ({
    id: r.id,
    version: versionFromRow(r),
    note: r.note,
    createdAt: r.created_at,
  }));
  const timeline = versions.length ? new PlanTimeline(versions.map((v) => v.version)) : null;

  const entries = new Map<string, Map<string, string>>();
  for (const e of actualRows.entries) {
    const m = entries.get(e.month) ?? new Map<string, string>();
    m.set(e.item_key, e.amount);
    entries.set(e.month, m);
  }

  // Gold at today's price replaces the planned gold value in the latest logged month's net worth
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const gold = owned.length ? valueHoldings(toHoldings(owned), effectivePrices(priceRows, feed), "0", todayIso) : null;
  const goldValue = gold && gold.missingPrices.length === 0 ? gold.market : null;
  const assetValues: Record<string, string> = {};
  const lastChecked = actualRows.checkins.map((c) => c.month).sort().at(-1);
  if (goldValue && lastChecked && timeline) {
    const planned = timeline.planned(lastChecked);
    const version = timeline.versionFor(lastChecked);
    if (planned && version) {
      let other = Dec.ZERO;
      for (const item of version.items) {
        if (item.kind === "asset" && !/gold|ذهب/i.test(item.name)) other = other.plus(planned.lines.get(item.key) ?? Dec.ZERO);
      }
      assetValues[lastChecked] = goldValue.plus(other).toString();
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
  };
}
