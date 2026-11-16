import { describe, expect, it } from "vitest";
import { buildActuals } from "../actuals.ts";
import { compareAll } from "../compare.ts";
import { buildAlerts, missedStreak } from "../alerts.ts";
import { goalProgress, plannedFinish, projectedFinish } from "../goal.ts";
import { PlanTimeline } from "../plan.ts";
import type { ActualsInput, PlanVersion } from "../types.ts";

const v1: PlanVersion = {
  versionNo: 1,
  effectiveFrom: "2026-01",
  start: "2026-01",
  horizonMonths: 12,
  openingBalance: "10000",
  rates: [{ from: "2026-01", annualRatePct: "12" }],
  items: [
    { key: "salary", kind: "income", name: "Salary", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "5000" }] },
    { key: "rent", kind: "expense", name: "Rent", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "2000" }] },
    { key: "food", kind: "expense", name: "Food", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "1000" }] },
    { key: "gold", kind: "asset", name: "Gold", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "5000" }] },
  ],
};
const timeline = new PlanTimeline([v1]);

const onPlanMonth = (month: string) => [
  { month, itemKey: "salary", amount: "5000" },
  { month, itemKey: "rent", amount: "2000" },
  { month, itemKey: "food", amount: "1000" },
];

describe("buildActuals", () => {
  it("uses the real investment profit/loss as Interest when given", () => {
    const a = buildActuals(timeline, {
      checkins: [{ month: "2026-01" }, { month: "2026-02" }],
      entries: [...onPlanMonth("2026-01"), ...onPlanMonth("2026-02")],
      unplanned: [],
      interest: { "2026-01": "50", "2026-02": "-30" },
    });
    expect(a.map((m) => m.interest.toString())).toEqual(["50", "-30"]);
    expect(a[1]!.balance.toString()).toBe("14020"); // 10000 + 2000 + 50 + 2000 - 30
  });

  it("returns nothing before the first check-in", () => {
    expect(buildActuals(timeline, { checkins: [], entries: [], unplanned: [] })).toEqual([]);
  });

  it("matches the plan exactly when actuals equal the plan", () => {
    const input: ActualsInput = {
      checkins: [{ month: "2026-01" }, { month: "2026-02" }],
      entries: [...onPlanMonth("2026-01"), ...onPlanMonth("2026-02")],
      unplanned: [],
    };
    const a = buildActuals(timeline, input);
    expect(a.map((x) => x.balance.toFixed(2))).toEqual(["12000.00", "14120.00"]);
    expect(a[1]!.balance.eq(timeline.planned("2026-02")!.balance)).toBe(true);
    expect(a[1]!.netWorth.toString()).toBe("19120"); // planned asset value used when no gold value given
  });

  it("counts a missing line in a checked-in month as 0 and adds unplanned items", () => {
    const a = buildActuals(timeline, {
      checkins: [{ month: "2026-01" }],
      entries: [{ month: "2026-01", itemKey: "salary", amount: "5000" }, { month: "2026-01", itemKey: "rent", amount: "2000" }],
      unplanned: [{ month: "2026-01", kind: "expense", name: "Car repair", amount: "1500" }],
    });
    expect(a[0]!.expenses.toString()).toBe("3500");
    expect(a[0]!.net.toString()).toBe("1500");
  });

  it("fills months without a check-in with the plan and marks them assumed", () => {
    const a = buildActuals(timeline, {
      checkins: [{ month: "2026-01" }, { month: "2026-03" }],
      entries: [...onPlanMonth("2026-01"), ...onPlanMonth("2026-03")],
      unplanned: [{ month: "2026-02", kind: "expense", name: "ignored", amount: "999" }],
    });
    expect(a.map((x) => x.assumed)).toEqual([false, true, false]);
    expect(a[1]!.net.toString()).toBe("2000"); // planned net, unplanned of an unchecked month ignored
  });

  it("uses the real bank balance when the check-in has one", () => {
    const a = buildActuals(timeline, {
      checkins: [{ month: "2026-01", savingsBalance: "11000" }, { month: "2026-02" }],
      entries: [...onPlanMonth("2026-01"), ...onPlanMonth("2026-02")],
      unplanned: [],
      assetValues: { "2026-02": "6000" },
    });
    expect(a[0]!.balance.toString()).toBe("11000");
    expect(a[0]!.balanceReported).toBe(true);
    expect(a[1]!.balance.toString()).toBe("13110"); // 11000 + 110 interest + 2000
    expect(a[1]!.netWorth.toString()).toBe("19110");
  });
});

describe("compareAll", () => {
  const actuals = buildActuals(timeline, {
    checkins: [{ month: "2026-01" }, { month: "2026-02" }, { month: "2026-03" }],
    entries: [
      ...onPlanMonth("2026-01"),
      { month: "2026-02", itemKey: "salary", amount: "5000" },
      { month: "2026-02", itemKey: "rent", amount: "2000" },
      { month: "2026-02", itemKey: "food", amount: "1300" },
      { month: "2026-03", itemKey: "salary", amount: "4800" },
      { month: "2026-03", itemKey: "rent", amount: "2000" },
      { month: "2026-03", itemKey: "food", amount: "900" },
    ],
    unplanned: [{ month: "2026-03", kind: "expense", name: "Car repair", amount: "700" }],
  });
  const cmp = compareAll(timeline, actuals);

  it("Gap = Actual - Planned per line, with the effect on Net", () => {
    const food = cmp[1]!.lines.find((l) => l.key === "food")!;
    expect(food.gap.toString()).toBe("300");
    expect(food.netEffect.toString()).toBe("-300");
    expect(food.status).toBe("worse");
    const salary = cmp[2]!.lines.find((l) => l.key === "salary")!;
    expect(salary.gap.toString()).toBe("-200");
    expect(salary.status).toBe("worse");
    const foodMar = cmp[2]!.lines.find((l) => l.key === "food")!;
    expect(foodMar.status).toBe("better");
  });

  it("totals and on-plan flag", () => {
    expect(cmp[0]!.onPlan).toBe(true);
    expect(cmp[0]!.net.gap.toString()).toBe("0");
    expect(cmp[1]!.onPlan).toBe(false);
    expect(cmp[2]!.net.gap.toString()).toBe("-800"); // -200 salary, +100 food, -700 repair
    expect(cmp[2]!.expenses.gap.toString()).toBe("600");
  });

  it("names the biggest cause of a gap, including unplanned items", () => {
    expect(cmp[1]!.biggestCause?.name).toBe("Food");
    expect(cmp[2]!.biggestCause?.name).toBe("Car repair");
    expect(cmp[0]!.biggestCause).toBeNull();
  });

  it("keeps cumulative gaps", () => {
    expect(cmp[2]!.cumulative.net.toString()).toBe("-1100");
    expect(cmp[2]!.cumulative.lines.get("food")!.toString()).toBe("200");
    expect(cmp[2]!.balance.gap.toFixed(2)).toBe(actuals[2]!.balance.minus(timeline.planned("2026-03")!.balance).toFixed(2));
  });

  it("alerts after 2 missed months in a row", () => {
    expect(missedStreak(cmp)).toBe(2);
    const alerts = buildAlerts(cmp, actuals, null, null);
    expect(alerts[0]!.message).toBe("Missed the plan 2 months in a row.");
    expect(alerts[0]!.level).toBe("danger");
  });

  it("compares each month against the version active in that month", () => {
    const v2: PlanVersion = { ...v1, versionNo: 2, effectiveFrom: "2026-03", items: v1.items.map((i) =>
      i.key === "salary" ? { ...i, amounts: [{ month: "2026-01", amount: "4800" }] } : i) };
    const t2 = new PlanTimeline([v1, v2]);
    const c2 = compareAll(t2, actuals);
    expect(c2[1]!.versionNo).toBe(1);
    expect(c2[2]!.versionNo).toBe(2);
    expect(c2[2]!.lines.find((l) => l.key === "salary")!.gap.toString()).toBe("0");
  });
});

describe("goal", () => {
  const goal = { targetAmount: "30000", targetMonth: "2026-06", monthlySavingsTarget: "2500" };

  it("progress = net worth / target", () => {
    expect(goalProgress("15000", goal).toString()).toBe("0.5");
  });

  it("planned finish is the first month the plan reaches the target", () => {
    // planned net worth: 17000, 19120, 21261.2, ... reaches 30000 in month 7
    const m = plannedFinish(timeline, goal);
    expect(m).toBe("2026-07");
    expect(timeline.planned("2026-06")!.netWorth.lt("30000")).toBe(true);
    expect(timeline.planned("2026-07")!.netWorth.gte("30000")).toBe(true);
  });

  it("projected finish without actuals equals the planned finish", () => {
    expect(projectedFinish(timeline, [], [], goal).month).toBe("2026-07");
  });

  it("projected finish moves later when you are behind plan", () => {
    const actuals = buildActuals(timeline, {
      checkins: [{ month: "2026-01" }, { month: "2026-02" }],
      entries: [
        { month: "2026-01", itemKey: "salary", amount: "4000" }, { month: "2026-01", itemKey: "rent", amount: "2000" }, { month: "2026-01", itemKey: "food", amount: "1000" },
        { month: "2026-02", itemKey: "salary", amount: "4000" }, { month: "2026-02", itemKey: "rent", amount: "2000" }, { month: "2026-02", itemKey: "food", amount: "1000" },
      ],
      unplanned: [],
    });
    const cmp = compareAll(timeline, actuals);
    const p = projectedFinish(timeline, actuals, cmp, goal);
    expect(p.averageNetGap.toString()).toBe("-1000");
    expect(p.basedOnMonths).toBe(2);
    expect(p.month! > "2026-07").toBe(true);
    expect(p.monthsVsTarget! > 0).toBe(true);
    const alerts = buildAlerts(cmp, actuals, goal, p);
    expect(alerts.some((a) => a.code === "behind_goal")).toBe(true);
    expect(alerts.some((a) => a.code === "below_savings_target")).toBe(true); // saved 1000 < 2500
  });

  it("returns null when the goal can never be reached", () => {
    const broke: PlanVersion = { ...v1, rates: [{ from: "2026-01", annualRatePct: "0" }],
      items: [{ key: "rent", kind: "expense", name: "Rent", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "100" }] }] };
    expect(plannedFinish(new PlanTimeline([broke]), goal)).toBeNull();
  });
});
