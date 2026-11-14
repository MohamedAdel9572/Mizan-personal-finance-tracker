import { describe, expect, it } from "vitest";
import { defaultEffective, draftFromVersion, draftToPayload, newItem, validateDraft, type Draft } from "../planDraft.ts";
import { SEED_PLAN } from "../../data/seed.ts";
import { normMobile, passwordProblem } from "../session.ts";
import { egp, money, monthLabel, signed } from "../format.ts";

const messages = (d: Draft) => validateDraft(d).map((p) => p.message);

describe("plan draft", () => {
  it("round-trips the seed plan with no problems", () => {
    const d = draftFromVersion(SEED_PLAN);
    expect(messages(d)).toEqual([]);
    const p = draftToPayload(d, "2026-11", "") as { items: { item_key?: string; start?: string }[]; opening_balance: string };
    expect(p.items[0]!.item_key).toBe("salary");
    expect(p.items[1]!.start).toBeUndefined(); // one-off lines send only their months
    expect(p.opening_balance).toBe("100000");
  });

  it("catches the same mistakes the database rejects", () => {
    const d = draftFromVersion(SEED_PLAN);
    d.items[2]!.end = "2026-10"; // car ends before it starts
    d.items[3]!.amounts[0]!.amount = "-5";
    d.rates = [];
    d.openingBalance = "abc";
    const m = messages(d);
    expect(m).toContain('"Car": end month is before the start month.');
    expect(m.some((x) => x.startsWith('"PS5": "-5" is not a valid amount'))).toBe(true);
    expect(m).toContain("Add the savings account interest rate.");
    expect(m.some((x) => x.startsWith("Opening balance"))).toBe(true);
  });

  it("requires a recurring line's first amount in its start month", () => {
    const d = draftFromVersion(SEED_PLAN);
    const item = newItem("expense", "2027-01");
    item.name = "Gym";
    item.amounts = [{ month: "2027-02", amount: "500" }];
    d.items.push(item);
    expect(messages(d)).toContain('"Gym": the first amount must be in the start month (2027-01).');
  });

  it("accepts amounts typed with thousand separators", () => {
    const d = draftFromVersion(SEED_PLAN);
    d.items[0]!.amounts[0]!.amount = "28,000";
    expect(messages(d)).toEqual([]);
    expect((draftToPayload(d, "2026-11", "") as { items: { amounts: { amount: string }[] }[] }).items[0]!.amounts[0]!.amount).toBe("28000");
  });

  it("picks a sensible effective month", () => {
    expect(defaultEffective("2026-11", "2027-03", "2026-11")).toBe("2027-03");
    expect(defaultEffective("2027-05", "2027-03", "2026-11")).toBe("2027-05");
    expect(defaultEffective("2026-01", null, "2026-11")).toBe("2026-11");
  });
});

describe("helpers", () => {
  it("normalises Egyptian mobiles like the database", () => {
    expect(normMobile("+20 100 000 0002")).toBe("01000000002");
    expect(normMobile("1000000002")).toBe("01000000002");
    expect(normMobile("010-0000-0002")).toBe("01000000002");
  });

  it("checks passwords like the database", () => {
    expect(passwordProblem("short")).toBe("Password must be at least 8 characters.");
    expect(passwordProblem("long-enough")).toBeNull();
  });

  it("formats money exactly with separators", () => {
    expect(money("1552937.4549")).toBe("1,552,937");
    expect(money("-1234.5", 2)).toBe("-1,234.50");
    expect(egp("100000")).toBe("100,000 EGP");
    expect(signed("300")).toBe("+300");
    expect(signed("-0.2")).toBe("0");
    expect(monthLabel("2026-11")).toBe("Nov 26");
    expect(monthLabel("2026-11", true)).toBe("Nov 2026");
  });
});
