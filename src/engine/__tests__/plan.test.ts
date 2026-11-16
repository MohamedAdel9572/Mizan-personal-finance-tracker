import { describe, expect, it } from "vitest";
import { itemAmount, planEnd, PlanTimeline, projectPlan, versionFor, versionFromRow } from "../plan.ts";
import type { PlanItem, PlanVersion } from "../types.ts";
import { SEED_PLAN } from "../../data/seed.ts";
import { Dec } from "../decimal.ts";

function plan(partial: Partial<PlanVersion>): PlanVersion {
  return {
    versionNo: 1,
    effectiveFrom: "2026-01",
    start: "2026-01",
    horizonMonths: 6,
    openingBalance: "1200",
    rates: [{ from: "2026-01", annualRatePct: "12" }], // 1% a month, easy to check by hand
    items: [],
    ...partial,
  };
}

const balances = (v: PlanVersion) => projectPlan(v).map((r) => r.balance.toFixed(4));

describe("projectPlan: formulas", () => {
  it("first month = opening + net, no interest", () => {
    const rows = projectPlan(plan({
      items: [{ key: "s", kind: "income", name: "S", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "100" }] }],
    }));
    expect(rows[0]!.interest.toString()).toBe("0");
    expect(rows[0]!.balance.toString()).toBe("1300");
  });

  it("compounds monthly on the previous balance", () => {
    expect(balances(plan({ horizonMonths: 4 }))).toEqual(["1200.0000", "1212.0000", "1224.1200", "1236.3612"]);
  });

  it("applies rate changes from their month", () => {
    const rows = projectPlan(plan({
      horizonMonths: 3,
      rates: [{ from: "2026-01", annualRatePct: "12" }, { from: "2026-03", annualRatePct: "24" }],
    }));
    expect(rows.map((r) => r.interest.toFixed(2))).toEqual(["0.00", "12.00", "24.24"]);
    expect(rows[2]!.annualRatePct.toString()).toBe("24");
  });

  it("handles one-off months", () => {
    const bonus: PlanItem = {
      key: "b", kind: "income", name: "Bonus", recurrence: "one_off", start: "2026-02", end: "2026-04",
      amounts: [{ month: "2026-02", amount: "500" }, { month: "2026-04", amount: "700" }],
    };
    expect(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"].map((m) => itemAmount(bonus, m).toString()))
      .toEqual(["0", "500", "0", "700", "0"]);
  });

  it("stops items that end mid-plan (end month inclusive)", () => {
    const tablet: PlanItem = {
      key: "t", kind: "expense", name: "Tablet", recurrence: "recurring", start: "2026-02", end: "2026-03",
      amounts: [{ month: "2026-02", amount: "960" }],
    };
    expect(["2026-01", "2026-02", "2026-03", "2026-04"].map((m) => itemAmount(tablet, m).toString()))
      .toEqual(["0", "960", "960", "0"]);
  });

  it("applies amount changes as a step function", () => {
    const salary: PlanItem = {
      key: "s", kind: "income", name: "Salary", recurrence: "recurring", start: "2026-01",
      amounts: [{ month: "2026-03", amount: "35000" }, { month: "2026-01", amount: "28000" }], // order doesn't matter
    };
    expect(["2026-01", "2026-02", "2026-03", "2027-01"].map((m) => itemAmount(salary, m).toString()))
      .toEqual(["28000", "28000", "35000", "35000"]);
  });

  it("handles negative months; no interest while the balance is negative", () => {
    const rows = projectPlan(plan({
      openingBalance: "0",
      horizonMonths: 2,
      items: [
        { key: "i", kind: "income", name: "I", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "1000" }] },
        { key: "e", kind: "expense", name: "E", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "1500" }] },
      ],
    }));
    expect(rows[0]!.net.toString()).toBe("-500");
    expect(rows[0]!.balance.toString()).toBe("-500");
    expect(rows[1]!.interest.toString()).toBe("0");
    expect(rows[1]!.balance.toString()).toBe("-1000");
  });

  it("starts earning interest again once the balance is back above zero", () => {
    const rows = projectPlan(plan({
      openingBalance: "0",
      horizonMonths: 3,
      items: [{ key: "x", kind: "income", name: "X", recurrence: "one_off", start: "2026-01", end: "2026-02",
                amounts: [{ month: "2026-02", amount: "1500" }] },
              { key: "e", kind: "expense", name: "E", recurrence: "recurring", start: "2026-01", end: "2026-01",
                amounts: [{ month: "2026-01", amount: "500" }] }],
    }));
    expect(rows.map((r) => r.balance.toString())).toEqual(["-500", "1000", "1010"]);
  });

  it("keeps assets out of net but in net worth", () => {
    const rows = projectPlan(plan({
      horizonMonths: 1,
      items: [{ key: "g", kind: "asset", name: "Gold", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "100000" }] }],
    }));
    expect(rows[0]!.net.toString()).toBe("0");
    expect(rows[0]!.netWorth.toString()).toBe("101200");
  });

  it("can project past the horizon for goal search", () => {
    const v = plan({ horizonMonths: 2 });
    expect(planEnd(v)).toBe("2026-02");
    expect(projectPlan(v, "2026-12")).toHaveLength(12);
  });
});

describe("plan versions", () => {
  const v1 = plan({ versionNo: 1, effectiveFrom: "2026-01", items: [
    { key: "s", kind: "income", name: "Salary", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "100" }] },
  ] });
  const v2 = plan({ versionNo: 2, effectiveFrom: "2026-04", items: [
    { key: "s", kind: "income", name: "Salary", recurrence: "recurring", start: "2026-01", amounts: [{ month: "2026-01", amount: "200" }] },
  ] });

  it("picks the version active in each month", () => {
    expect(versionFor([v1, v2], "2025-12")).toBeUndefined();
    expect(versionFor([v1, v2], "2026-03")?.versionNo).toBe(1);
    expect(versionFor([v1, v2], "2026-04")?.versionNo).toBe(2);
    expect(versionFor([v2, v1], "2030-01")?.versionNo).toBe(2);
  });

  it("a newer version starting earlier wins over an older one starting later", () => {
    const v3 = { ...v1, versionNo: 3, effectiveFrom: "2026-02" };
    expect(versionFor([v1, v2, v3], "2026-01")?.versionNo).toBe(1);
    expect(versionFor([v1, v2, v3], "2026-02")?.versionNo).toBe(3);
    expect(versionFor([v1, v2, v3], "2026-06")?.versionNo).toBe(3);
  });

  it("same effective month: the higher version number wins", () => {
    const v3 = { ...v2, versionNo: 3 };
    expect(versionFor([v1, v3, v2], "2026-05")?.versionNo).toBe(3);
  });

  it("switches planned values when a new version starts", () => {
    const t = new PlanTimeline([v2, v1]);
    expect(t.planned("2026-03")?.income.toString()).toBe("100");
    expect(t.planned("2026-04")?.income.toString()).toBe("200");
    // the new version is a full plan from its own start, so its balance includes months 1-3 at 200
    expect(t.planned("2026-04")?.balance.toFixed(2)).toBe(projectPlan(v2)[3]!.balance.toFixed(2));
    expect(t.planned("2025-12")).toBeUndefined();
  });

  it("finds line names from any version", () => {
    const t = new PlanTimeline([v1, plan({ versionNo: 2, effectiveFrom: "2026-02", items: [] })]);
    expect(t.lineInfo("s")?.name).toBe("Salary");
  });

  it("maps the get_plan_versions() row shape", () => {
    const v = versionFromRow({
      version_no: 1, effective_from: "2026-11", start_month: "2026-11", horizon_months: 24, opening_balance: "100000.00",
      rates: [{ from: "2026-11", annual_rate_pct: "17.0000" }],
      items: [{ item_key: "k", kind: "income", name: "Salary", recurrence: "recurring", start: "2026-11", end: null,
                amounts: [{ month: "2026-11", amount: "28000.00" }] }],
    });
    expect(projectPlan(v)[0]!.balance.toString()).toBe("128000");
  });
});

describe("seed plan from the Excel sheet", () => {
  const rows = projectPlan(SEED_PLAN);
  const at = (m: string) => rows.find((r) => r.month === m)!;

  it("covers 24 months: 2026-11 to 2028-10", () => {
    expect(rows).toHaveLength(24);
    expect(rows[0]!.month).toBe("2026-11");
    expect(rows[23]!.month).toBe("2028-10");
  });

  it("2026-11 (hand-checked)", () => {
    const r = at("2026-11");
    expect(r.income.toString()).toBe("28000");
    expect(r.expenses.toString()).toBe("25760"); // car 5300 + uber 3500 + doctor 6000 + lifestyle 10000 + tablet 960
    expect(r.net.toString()).toBe("2240");
    expect(r.balance.toString()).toBe("102240");
    expect(r.netWorth.toString()).toBe("202240");
  });

  it("2026-12 (hand-checked)", () => {
    const r = at("2026-12");
    expect(r.income.toString()).toBe("60000"); // + bonus 32000
    expect(r.expenses.toString()).toBe("28760"); // + PS5 3000
    expect(r.interest.toString()).toBe("1448.4"); // 102240 x 17% / 12
    expect(r.balance.toString()).toBe("134928.4");
  });

  it("2027-01: doctor ended, interest keeps compounding", () => {
    const r = at("2027-01");
    expect(r.expenses.toString()).toBe("22760");
    expect(r.interest.toFixed(2)).toBe("1911.49");
    expect(r.balance.toFixed(2)).toBe("142079.89");
  });

  it("2027-03: raise, big bonus, car goes up, tablet ended", () => {
    const r = at("2027-03");
    expect(r.income.toString()).toBe("335000");
    expect(r.expenses.toString()).toBe("24500");
    expect(r.net.toString()).toBe("310500");
  });

  it("2027-12 PS5 ended, 2028-03 second raise and bonus", () => {
    expect(at("2027-12").lines.get("ps5")!.toString()).toBe("0");
    expect(at("2027-11").lines.get("ps5")!.toString()).toBe("3000");
    expect(at("2028-03").income.toString()).toBe("543750");
  });
});

describe("known interest", () => {
  it("replaces the rate in the months it covers", () => {
    const v = plan({ knownInterest: { "2026-01": "100", "2026-02": "-40" } });
    const rows = projectPlan(v);
    expect(rows[0]!.interest.toString()).toBe("100");
    expect(rows[1]!.interest.toString()).toBe("-40");
    expect(rows[0]!.balance.toString()).toBe(Dec.of(v.openingBalance).plus(rows[0]!.net).plus(100).toString());
  });
});
