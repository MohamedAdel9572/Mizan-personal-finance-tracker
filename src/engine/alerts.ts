import { Dec } from "./decimal.ts";
import type { MonthComparison } from "./compare.ts";
import type { Goal, ProjectedFinish } from "./goal.ts";
import type { ActualMonth } from "./types.ts";

export type AlertLevel = "info" | "warning" | "danger";

export interface Alert {
  code: "missed_streak" | "behind_goal" | "below_savings_target" | "negative_balance" | "ahead_of_goal";
  level: AlertLevel;
  message: string;
}

function fmt(d: Dec): string {
  return Number(d.toFixed(0)).toLocaleString("en-US");
}

/** Number of consecutive checked-in months, ending with the latest, below planned Net. */
export function missedStreak(comparisons: readonly MonthComparison[]): number {
  let n = 0;
  for (const c of [...comparisons].reverse()) {
    if (c.assumed) continue;
    if (c.onPlan) break;
    n++;
  }
  return n;
}

export function buildAlerts(
  comparisons: readonly MonthComparison[],
  actuals: readonly ActualMonth[],
  goal: Goal | null,
  projection: ProjectedFinish | null,
): Alert[] {
  const alerts: Alert[] = [];
  const lastCmp = [...comparisons].reverse().find((c) => !c.assumed);
  const lastActual = [...actuals].reverse().find((a) => !a.assumed);

  const streak = missedStreak(comparisons);
  if (streak >= 2) {
    alerts.push({ code: "missed_streak", level: "danger", message: `Missed the plan ${streak} months in a row.` });
  } else if (streak === 1 && lastCmp) {
    const cause = lastCmp.biggestCause ? ` Biggest cause: ${lastCmp.biggestCause.name}.` : "";
    alerts.push({ code: "missed_streak", level: "warning", message: `Missed the plan in ${lastCmp.month}.${cause}` });
  }

  if (goal?.monthlySavingsTarget && lastActual) {
    const target = Dec.of(goal.monthlySavingsTarget);
    if (lastActual.net.lt(target)) {
      alerts.push({
        code: "below_savings_target",
        level: "warning",
        message: `Saved ${fmt(lastActual.net)} EGP in ${lastActual.month}, target is ${fmt(target)} EGP.`,
      });
    }
  }

  if (lastActual && lastActual.balance.isNegative()) {
    alerts.push({ code: "negative_balance", level: "danger", message: `Savings balance is negative in ${lastActual.month}.` });
  }

  if (goal && projection) {
    if (projection.month === null) {
      alerts.push({ code: "behind_goal", level: "danger", message: "At the current pace the goal is not reached within 50 years." });
    } else if ((projection.monthsVsTarget ?? 0) > 0) {
      alerts.push({
        code: "behind_goal",
        level: "warning",
        message: `At the current pace you reach the goal in ${projection.month}, ${projection.monthsVsTarget} months after ${goal.targetMonth}.`,
      });
    } else if ((projection.monthsVsTarget ?? 0) < 0) {
      alerts.push({
        code: "ahead_of_goal",
        level: "info",
        message: `At the current pace you reach the goal in ${projection.month}, ${-projection.monthsVsTarget!} months early.`,
      });
    }
  }
  return alerts;
}
