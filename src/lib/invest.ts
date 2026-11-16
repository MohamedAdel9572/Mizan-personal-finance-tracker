// Investments: where your savings sit (Mashreq daily profit, Thndr, a fund, ...).
// All of them together are your savings balance. Each month:
//   end = start + profit/loss + money moved in - money moved out (+ the month's savings,
//         for the one investment where savings land)
// The total profit/loss of a month is the plan's actual Interest for that month.
import { Dec } from "../engine/decimal.ts";
import { monthRange, type Month } from "../engine/month.ts";

export type RateUnit = "yearly" | "monthly" | "daily";

export interface InvestAccount {
  id: number;
  name: string;
  opening: string;
  usual_rate: string | null;
  rate_unit: RateUnit;
  receives_savings: boolean;
  created_at: string;
}
export interface InvestMonth {
  account_id: number;
  month: Month;
  profit: string;
  rate: string | null;
  rate_unit: RateUnit | null;
  note: string;
}
export interface InvestMove {
  id: number;
  from_account: number;
  to_account: number;
  amount: string;
  date: string;
  note: string;
}
export interface InvestData { accounts: InvestAccount[]; months: InvestMonth[]; moves: InvestMove[] }

export const EMPTY_INVEST: InvestData = { accounts: [], months: [], moves: [] };

function daysIn(month: Month): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Profit for a month from a rate (%), on the balance at the start of the month. */
export function profitFromRate(base: Dec, ratePct: Dec, unit: RateUnit, month: Month): Dec {
  if (!base.gt(0)) return Dec.ZERO;
  const r = ratePct.div(100);
  const p = unit === "yearly" ? base.times(r).div(12) : unit === "monthly" ? base.times(r) : base.times(r).times(daysIn(month));
  return p.round(2);
}

/** month -> total profit/loss of all investments (only months with something logged). */
export function interestByMonth(data: InvestData): Record<Month, string> {
  const out: Record<Month, Dec> = {};
  for (const m of data.months) out[m.month] = (out[m.month] ?? Dec.ZERO).plus(Dec.of(m.profit));
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toString()]));
}

export interface LedgerRow {
  month: Month;
  start: Dec;
  profit: Dec | null; // null = not logged
  moved: Dec; // in - out
  savings: Dec; // the month's savings landing here
  end: Dec;
}

/**
 * Month-by-month balance of every investment from the plan start to `upto`.
 * netOf(month) = the month's savings (income - expenses), actual when logged, else planned.
 */
export function ledger(data: InvestData, start: Month, upto: Month, netOf: (m: Month) => Dec): Map<number, LedgerRow[]> {
  const out = new Map<number, LedgerRow[]>();
  if (upto < start) return out;
  const months = monthRange(start, upto);
  const savingsId = data.accounts.find((a) => a.receives_savings)?.id ?? data.accounts[0]?.id;
  const profit = new Map(data.months.map((m) => [`${m.account_id}:${m.month}`, Dec.of(m.profit)]));
  for (const a of data.accounts) {
    let bal = Dec.of(a.opening);
    const rows: LedgerRow[] = [];
    for (const m of months) {
      const startBal = bal;
      const p = profit.get(`${a.id}:${m}`) ?? null;
      let moved = Dec.ZERO;
      for (const v of data.moves) {
        // a move dated before the plan start counts in the first month
        const vm = v.date.slice(0, 7) < start ? start : v.date.slice(0, 7);
        if (vm !== m) continue;
        if (v.to_account === a.id) moved = moved.plus(Dec.of(v.amount));
        if (v.from_account === a.id) moved = moved.minus(Dec.of(v.amount));
      }
      const savings = a.id === savingsId ? netOf(m) : Dec.ZERO;
      bal = bal.plus(p ?? Dec.ZERO).plus(moved).plus(savings);
      rows.push({ month: m, start: startBal, profit: p, moved, savings, end: bal });
    }
    out.set(a.id, rows);
  }
  return out;
}
