/**
 * Loads everything a signed-in user needs in two RPC calls and builds the
 * engine objects once. Screens read from here and call reload() after saving.
 */
import { buildActuals } from "../engine/actuals.ts";
import { compareAll, type MonthComparison } from "../engine/compare.ts";
import { PlanTimeline, versionFromRow, type PlanVersionRow } from "../engine/plan.ts";
import type { ActualMonth, ActualsInput, Checkin, PlanVersion } from "../engine/types.ts";
import type { Api } from "./api.ts";

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
}

export async function loadProfile(api: Api): Promise<Profile | null> {
  const rows = await api.rpc<Profile[]>("app_me");
  return rows[0] ?? null;
}

export async function loadData(api: Api, profile: Profile): Promise<AppData> {
  const [versionRows, actualRows] = await Promise.all([
    api.rpc<(PlanVersionRow & { id: number; note: string; created_at: string })[]>("get_plan_versions"),
    api.rpc<ActualsRow>("get_actuals"),
  ]);

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

  const input: ActualsInput = {
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
  };
}
