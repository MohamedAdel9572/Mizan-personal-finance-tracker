import { describe, expect, it } from "vitest";
import { amountOf, dateOf, monthOf, parseImport } from "../importer.ts";
import type { Sheet } from "../xlsx.ts";

const cell = (value: string | number) => ({ value, raw: String(value) });

function sheet(name: string, rows: Record<string, string | number>): Sheet {
  const cells = new Map(Object.entries(rows).map(([k, v]) => [k, cell(v)]));
  const maxRow = Math.max(...Object.keys(rows).map((k) => Number(/\d+$/.exec(k)![0])));
  return { name, cells, maxRow };
}

describe("import cell readers", () => {
  it("reads months from Excel dates and text", () => {
    expect(monthOf(cell(46327))).toBe("2026-11"); // 2026-11-01 as an Excel date
    expect(monthOf(cell("2027-3"))).toBe("2027-03");
    expect(monthOf(cell("03/2027"))).toBe("2027-03");
    expect(monthOf(cell("21/03/2027"))).toBe("2027-03");
    expect(monthOf(cell("2027-13"))).toBeNull();
    expect(monthOf(cell("soon"))).toBeNull();
  });

  it("reads dates", () => {
    expect(dateOf(cell("21/03/2025"))).toBe("2025-03-21");
    expect(dateOf(cell("2025-06-26"))).toBe("2025-06-26");
    expect(dateOf(cell("31/02/2025"))).toBeNull();
  });

  it("reads amounts exactly, with separators and EGP", () => {
    expect(amountOf(cell("EGP 12,510"))).toBe("12510");
    expect(amountOf(cell(2.5))).toBe("2.5");
    expect(amountOf(cell("-5"))).toBeNull();
    expect(amountOf(cell("1.234"))).toBeNull();
  });
});

describe("parseImport", () => {
  const settings = sheet("Settings", { B3: 46327, B4: 12, B5: 1000, A10: 46327, B10: 0.17 });

  it("builds a plan from template rows and names the row of every problem", () => {
    const lines = sheet("Lines", {
      A1: "Type", A2: "Income", B2: "Salary", C2: "Every month", D2: "2026-11", F2: 28000,
      A3: "Income", B3: "Salary", C3: "Every month", D3: "2027-03", F3: 35000,
      A4: "Expense", B4: "Car", C4: "Every month", D4: "2026-11", E4: "2026-10", F4: 5300,
      A5: "Loan", B5: "X", C5: "One-off", D5: "2026-12", F5: 1,
    });
    const r = parseImport([settings, lines], { today: "2026-11-14", existingLines: [] });
    expect(r.problems.map((p) => `${p.sheet}:${p.row}`)).toEqual(["Lines:4", "Lines:5"]);
    expect(r.draft?.items[0]?.amounts).toEqual([{ month: "2026-11", amount: "28000" }, { month: "2027-03", amount: "35000" }]);
    expect(r.draft?.rates[0]?.rate).toBe("17");
  });

  it("reads a month-columns sheet like the original Excel", () => {
    const grid = sheet("Sheet1", {
      B3: "Income", C3: "2026-11", D3: "2026-12", E3: "2027-01", F3: "2027-02",
      B4: "Salary", C4: 28000, D4: 28000, E4: 28000, F4: 35000,
      B5: "Bonus", D5: 32000, F5: 300000,
      B6: "Total", C6: 28000,
      B9: "Installments", C9: "2026-11", D9: "2026-12", E9: "2027-01", F9: "2027-02",
      B10: "Tablet", C10: 960, D10: 960,
      B28: "Assets", C28: "2026-11", D28: "2026-12", E28: "2027-01", F28: "2027-02",
      B29: "Gold", C29: 100000, D29: 100000, E29: 100000, F29: 100000,
      B30: "Cloud (17% annual interest)", C30: 100000, D30: 101416.66666666667,
    });
    const r = parseImport([grid], { today: "2026-11-14", existingLines: [] });
    expect(r.source).toBe("grid");
    expect(r.problems).toEqual([]);
    const byName = Object.fromEntries(r.draft!.items.map((i) => [i.name, i]));
    expect(byName.Salary!.amounts).toEqual([{ month: "2026-11", amount: "28000" }, { month: "2027-02", amount: "35000" }]);
    expect(byName.Bonus!.recurrence).toBe("one_off");
    expect(byName.Tablet!.end).toBe("2026-12");
    expect(byName.Total).toBeUndefined();
    expect(r.draft!.openingBalance).toBe("100000");
    expect(r.draft!.rates[0]!.rate).toBe("17");
  });

  it("rejects future actuals and unknown lines", () => {
    const act = sheet("Actuals", { A2: "2027-01", B2: "Salary", C2: 1, A3: "2026-11", B3: "Netflix", C3: 1 });
    const r = parseImport([act], { today: "2026-11-14", existingLines: ["Salary"] });
    expect(r.problems.map((p) => p.message)).toEqual(["2027-01 is in the future.", '"Netflix" is not an income or expense line in the plan.']);
  });
});
