import { describe, expect, it } from "vitest";
import { Dec } from "../../engine/decimal.ts";
import { interestByMonth, ledger, profitFromRate, type InvestData } from "../invest.ts";

const data: InvestData = {
  accounts: [
    { id: 1, name: "Mashreq", opening: "100000", usual_rate: "17", rate_unit: "yearly", receives_savings: true, created_at: "" },
    { id: 2, name: "Thndr", opening: "0", usual_rate: null, rate_unit: "yearly", receives_savings: false, created_at: "" },
  ],
  months: [
    { account_id: 1, month: "2026-11", profit: "1416.67", rate: "17", rate_unit: "yearly", note: "" },
    { account_id: 2, month: "2026-12", profit: "-800", rate: null, rate_unit: null, note: "" },
    { account_id: 1, month: "2026-12", profit: "1200", rate: null, rate_unit: null, note: "" },
  ],
  moves: [{ id: 1, from_account: 1, to_account: 2, amount: "20000", date: "2026-12-10", note: "" }],
};

describe("investments", () => {
  it("profit from a rate", () => {
    expect(profitFromRate(Dec.of(100000), Dec.of(17), "yearly", "2026-11").toString()).toBe("1416.67");
    expect(profitFromRate(Dec.of(100000), Dec.of(1.5), "monthly", "2026-11").toString()).toBe("1500");
    expect(profitFromRate(Dec.of(100000), Dec.of(0.05), "daily", "2026-11").toString()).toBe("1500"); // 30 days
    expect(profitFromRate(Dec.of(0), Dec.of(17), "yearly", "2026-11").toString()).toBe("0");
  });
  it("interest by month = total profit/loss", () => {
    expect(interestByMonth(data)).toEqual({ "2026-11": "1416.67", "2026-12": "400" });
  });
  it("ledger: profit, moves and savings", () => {
    const l = ledger(data, "2026-11", "2026-12", () => Dec.of(5000));
    const m = l.get(1)!;
    const t = l.get(2)!;
    expect(m.map((r) => r.end.toString())).toEqual(["106416.67", "92616.67"]);
    expect(t.map((r) => r.end.toString())).toEqual(["0", "19200"]);
    // together: opening + savings + profit
    expect(m[1]!.end.plus(t[1]!.end).toString()).toBe(Dec.of(100000).plus(10000).plus(1416.67).plus(400).toString());
  });
});
