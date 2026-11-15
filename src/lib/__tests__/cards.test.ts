import { describe, expect, it } from "vitest";
import { cardState, daysUntil, nextDue, type CardRow, type TxnRow } from "../cards.ts";

const credit: CardRow = { id: 1, name: "CIB Visa", bank: "CIB", kind: "credit", last4: "4417", color: "indigo",
  credit_limit: "50000.00", opening_balance: "2000.00", due_day: 25, created_at: "2026-11-01T00:00:00Z" };
const debit: CardRow = { ...credit, id: 2, kind: "debit", credit_limit: null, opening_balance: "10000.00", due_day: null };
const t = (id: number, card_id: number, kind: TxnRow["kind"], amount: string, date: string): TxnRow =>
  ({ id, card_id, kind, amount, date, note: "", created_at: "" });
const txns = [
  t(3, 1, "payment", "1000", "2026-11-05"),
  t(1, 1, "spend", "1250.50", "2026-11-01"),
  t(2, 2, "spend", "300", "2026-11-02"),
  t(4, 1, "refund", "250.50", "2026-10-20"),
];

describe("cards", () => {
  it("credit: used, available, utilization and running available", () => {
    const s = cardState(credit, txns, "2026-11");
    expect(s.used.toString()).toBe("2000");
    expect(s.available.toString()).toBe("48000");
    expect(s.utilization).toBe(0.04);
    expect(s.spentThisMonth.toString()).toBe("1250.5");
    expect(s.history.map((h) => h.after.toString())).toEqual(["48000", "47000", "48250.5"]);
  });
  it("debit: balance", () => {
    const s = cardState(debit, txns, "2026-11");
    expect(s.available.toString()).toBe("9700");
    expect(s.limit).toBeNull();
  });
  it("overpaying a credit card leaves money in your favour", () => {
    const s = cardState({ ...credit, opening_balance: "0" }, [t(1, 1, "payment", "500", "2026-11-01")], "2026-11");
    expect(s.used.toString()).toBe("-500");
    expect(s.utilization).toBe(0);
  });
  it("next due date", () => {
    expect(nextDue(25, "2026-11-16")).toBe("2026-11-25");
    expect(nextDue(10, "2026-11-16")).toBe("2026-12-10");
    expect(nextDue(31, "2027-02-01")).toBe("2027-02-28");
    expect(nextDue(5, "2026-12-20")).toBe("2027-01-05");
    expect(daysUntil("2026-11-25", "2026-11-16")).toBe(9);
  });
});
