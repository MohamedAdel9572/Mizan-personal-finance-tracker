import { Dec, type DecimalInput } from "./decimal.ts";
import { addMonths, monthsBetween, type Month } from "./month.ts";
import { monthlyInterest, type PlanTimeline } from "./plan.ts";
import type { MonthComparison } from "./compare.ts";
import type { ActualMonth, Money } from "./types.ts";

export interface Goal {
  targetAmount: Money;
  targetMonth: Month;
  monthlySavingsTarget?: Money | null;
}

/** Search limit for finish dates: 50 years. Beyond that we say "not reachable". */
export const MAX_SEARCH_MONTHS = 600;

/** Goal progress = Net worth / Target (0.25 = 25%). Not capped at 100%. */
export function goalProgress(netWorth: DecimalInput, goal: Goal): Dec {
  return Dec.of(netWorth).div(goal.targetAmount);
}

/** First month where the plan's net worth reaches the target, or null. */
export function plannedFinish(timeline: PlanTimeline, goal: Goal, maxMonths = MAX_SEARCH_MONTHS): Month | null {
  for (let i = 0; i < maxMonths; i++) {
    const m = addMonths(timeline.start, i);
    const p = timeline.planned(m);
    if (p && p.netWorth.gte(goal.targetAmount)) return m;
  }
  return null;
}

export interface ProjectedFinish {
  month: Month | null;
  /** average monthly Net gap used for the projection */
  averageNetGap: Dec;
  /** how many checked-in months the average is based on */
  basedOnMonths: number;
  /** months after (+) or before (-) the goal's target month; null if not reachable */
  monthsVsTarget: number | null;
}

/**
 * Projected finish at the current actual pace.
 *
 * Starts from the last checked-in month's real balance and assets, then walks
 * the plan forward. Each future month uses the planned Net plus the average
 * Net gap of the last `window` checked-in months. That keeps planned bonuses
 * and salary raises in the projection, but carries forward how far off plan
 * you have actually been. Asset value moves by the planned change only
 * (no gold price forecast).
 */
export function projectedFinish(
  timeline: PlanTimeline,
  actuals: readonly ActualMonth[],
  comparisons: readonly MonthComparison[],
  goal: Goal,
  window = 6,
  maxMonths = MAX_SEARCH_MONTHS,
): ProjectedFinish {
  const target = Dec.of(goal.targetAmount);
  const lastActual = [...actuals].reverse().find((a) => !a.assumed);
  const recent = comparisons.filter((c) => !c.assumed).slice(-window);
  const averageNetGap = recent.length
    ? Dec.sum(recent.map((c) => c.net.gap)).div(recent.length)
    : Dec.ZERO;
  const result = (month: Month | null): ProjectedFinish => ({
    month,
    averageNetGap,
    basedOnMonths: recent.length,
    monthsVsTarget: month ? monthsBetween(goal.targetMonth, month) : null,
  });

  if (!lastActual) return result(plannedFinish(timeline, goal, maxMonths));
  if (lastActual.netWorth.gte(target)) return result(lastActual.month);

  let balance = lastActual.balance;
  const plannedAssetsAtLast = timeline.planned(lastActual.month)?.assets ?? Dec.ZERO;
  for (let i = 1; i <= maxMonths; i++) {
    const m = addMonths(lastActual.month, i);
    const p = timeline.planned(m);
    if (!p) continue;
    balance = balance.plus(monthlyInterest(balance, p.annualRatePct)).plus(p.net).plus(averageNetGap);
    const assets = lastActual.assets.plus(p.assets.minus(plannedAssetsAtLast));
    if (balance.plus(assets).gte(target)) return result(m);
  }
  return result(null);
}
