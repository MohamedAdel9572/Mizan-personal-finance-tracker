import { Dec } from "./decimal.ts";
import { monthRange, type Month } from "./month.ts";
import { monthlyInterest, type PlanTimeline } from "./plan.ts";
import type { ActualMonth, ActualsInput, UnplannedItem } from "./types.ts";

/**
 * Builds the real month-by-month series from the plan start to the last
 * checked-in month.
 *
 * Rules (the non-obvious ones):
 * - A month counts as "actual" only when it has a check-in. Inside a
 *   checked-in month, a planned line with no entry counts as 0 (the Log
 *   screen pre-fills planned amounts, so a missing entry means "didn't happen").
 * - A month with no check-in between the start and the last check-in is
 *   filled with the planned values and marked assumed=true, so the balance
 *   chain doesn't break. The UI greys these months out.
 * - Interest uses the rate of the plan version active that month, unless
 *   input.interest has the real profit/loss of your investments for it.
 * - If the check-in has a real bank balance, it replaces the computed balance
 *   from that month on (the bank is the truth; the formula is an estimate).
 * - Asset value comes from input.assetValues (gold at that month's price),
 *   or the planned asset value when missing.
 */
export function buildActuals(timeline: PlanTimeline, input: ActualsInput): ActualMonth[] {
  const checked = new Map(input.checkins.map((c) => [c.month, c]));
  if (checked.size === 0) return [];
  const last = [...checked.keys()].sort().at(-1)!;
  const start = timeline.start;
  if (last < start) return [];

  const entriesByMonth = new Map<Month, Map<string, Dec>>();
  for (const e of input.entries) {
    const m = entriesByMonth.get(e.month) ?? new Map<string, Dec>();
    m.set(e.itemKey, (m.get(e.itemKey) ?? Dec.ZERO).plus(e.amount));
    entriesByMonth.set(e.month, m);
  }
  const unplannedByMonth = new Map<Month, UnplannedItem[]>();
  for (const u of input.unplanned) {
    const list = unplannedByMonth.get(u.month) ?? [];
    list.push(u);
    unplannedByMonth.set(u.month, list);
  }

  const out: ActualMonth[] = [];
  let balance = Dec.of(timeline.first.openingBalance);

  monthRange(start, last).forEach((month, i) => {
    const planned = timeline.planned(month);
    const checkin = checked.get(month);
    const assumed = !checkin;
    const lines = new Map<string, Dec>();
    let income = Dec.ZERO;
    let expenses = Dec.ZERO;
    const unplanned = assumed ? [] : (unplannedByMonth.get(month) ?? []);

    if (assumed) {
      for (const [key, amount] of planned?.lines ?? []) {
        const kind = timeline.lineInfo(key)?.kind;
        if (kind === "asset") continue;
        lines.set(key, amount);
        if (kind === "income") income = income.plus(amount);
        else expenses = expenses.plus(amount);
      }
    } else {
      for (const [key, amount] of entriesByMonth.get(month) ?? []) {
        const kind = timeline.lineInfo(key)?.kind;
        if (!kind || kind === "asset") continue; // unknown keys are ignored (DB rejects them anyway)
        lines.set(key, amount);
        if (kind === "income") income = income.plus(amount);
        else expenses = expenses.plus(amount);
      }
      for (const u of unplanned) {
        if (u.kind === "income") income = income.plus(u.amount);
        else expenses = expenses.plus(u.amount);
      }
    }

    const net = income.minus(expenses);
    const rate = planned?.annualRatePct ?? Dec.ZERO;
    const real = input.interest?.[month];
    const interest = real != null ? Dec.of(real) : i === 0 ? Dec.ZERO : monthlyInterest(balance, rate);
    balance = balance.plus(interest).plus(net);
    const reported = checkin?.savingsBalance != null && checkin.savingsBalance !== "";
    if (reported) balance = Dec.of(checkin!.savingsBalance!);

    const assetText = input.assetValues?.[month];
    const assets = assetText != null ? Dec.of(assetText) : (planned?.assets ?? Dec.ZERO);

    out.push({
      month,
      assumed,
      lines,
      unplanned,
      income,
      expenses,
      net,
      interest,
      balance,
      balanceReported: reported,
      assets,
      netWorth: balance.plus(assets),
    });
  });
  return out;
}
