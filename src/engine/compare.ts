import { Dec } from "./decimal.ts";
import type { Month } from "./month.ts";
import type { PlanTimeline } from "./plan.ts";
import type { ActualMonth } from "./types.ts";

export type LineKind = "income" | "expense" | "unplanned_income" | "unplanned_expense";
export type GapStatus = "on_plan" | "better" | "worse";

export interface LineGap {
  key: string;
  name: string;
  kind: LineKind;
  planned: Dec;
  actual: Dec;
  /** Gap = Actual - Planned (as specified) */
  gap: Dec;
  /** Effect on Net: + is good. Income gap as is, expense gap negated. */
  netEffect: Dec;
  status: GapStatus;
}

export interface TotalGap {
  planned: Dec;
  actual: Dec;
  gap: Dec;
}

export interface MonthComparison {
  month: Month;
  versionNo: number;
  assumed: boolean;
  lines: LineGap[];
  income: TotalGap;
  expenses: TotalGap;
  net: TotalGap;
  balance: TotalGap;
  netWorth: TotalGap;
  /** Line that hurt Net the most this month (null when nothing was worse than plan) */
  biggestCause: LineGap | null;
  /** Month counts as "on plan" when actual Net >= planned Net */
  onPlan: boolean;
  cumulative: {
    /** sum of Net gaps from the first month to this one (checked-in months only) */
    net: Dec;
    /** per line: sum of gaps so far */
    lines: Map<string, Dec>;
  };
}

function total(planned: Dec, actual: Dec): TotalGap {
  return { planned, actual, gap: actual.minus(planned) };
}

function status(netEffect: Dec): GapStatus {
  return netEffect.isZero() ? "on_plan" : netEffect.isNegative() ? "worse" : "better";
}

/**
 * Plan vs actual for every month of the actual series.
 *
 * "On plan" is judged on Net (cash flow), not net worth: a drop in the gold
 * price shouldn't count as "you missed your plan". Net worth gaps are still
 * reported for the dashboard.
 */
export function compareAll(timeline: PlanTimeline, actuals: readonly ActualMonth[]): MonthComparison[] {
  const cumulativeLines = new Map<string, Dec>();
  let cumulativeNet = Dec.ZERO;
  const out: MonthComparison[] = [];

  for (const a of actuals) {
    const planned = timeline.planned(a.month);
    const version = timeline.versionFor(a.month);
    if (!planned || !version) continue;

    const lines: LineGap[] = [];
    const keys = new Set<string>();
    for (const item of version.items) if (item.kind !== "asset") keys.add(item.key);
    for (const key of a.lines.keys()) keys.add(key);

    for (const key of keys) {
      const info = timeline.lineInfo(key);
      if (!info || info.kind === "asset") continue;
      const p = planned.lines.get(key) ?? Dec.ZERO;
      const act = a.lines.get(key) ?? Dec.ZERO;
      if (p.isZero() && act.isZero()) continue;
      const gap = act.minus(p);
      const netEffect = info.kind === "income" ? gap : gap.neg();
      lines.push({ key, name: info.name, kind: info.kind, planned: p, actual: act, gap, netEffect, status: status(netEffect) });
    }
    a.unplanned.forEach((u, i) => {
      const amount = Dec.of(u.amount);
      const netEffect = u.kind === "income" ? amount : amount.neg();
      lines.push({
        key: `unplanned:${a.month}:${i}`,
        name: u.name,
        kind: u.kind === "income" ? "unplanned_income" : "unplanned_expense",
        planned: Dec.ZERO,
        actual: amount,
        gap: amount,
        netEffect,
        status: status(netEffect),
      });
    });

    if (!a.assumed) {
      cumulativeNet = cumulativeNet.plus(a.net.minus(planned.net));
      for (const l of lines) cumulativeLines.set(l.key, (cumulativeLines.get(l.key) ?? Dec.ZERO).plus(l.gap));
    }

    let biggestCause: LineGap | null = null;
    for (const l of lines) {
      if (l.netEffect.isNegative() && (!biggestCause || l.netEffect.lt(biggestCause.netEffect))) biggestCause = l;
    }

    out.push({
      month: a.month,
      versionNo: version.versionNo,
      assumed: a.assumed,
      lines,
      income: total(planned.income, a.income),
      expenses: total(planned.expenses, a.expenses),
      net: total(planned.net, a.net),
      balance: total(planned.balance, a.balance),
      netWorth: total(planned.netWorth, a.netWorth),
      biggestCause,
      onPlan: a.net.gte(planned.net),
      cumulative: { net: cumulativeNet, lines: new Map(cumulativeLines) },
    });
  }
  return out;
}
