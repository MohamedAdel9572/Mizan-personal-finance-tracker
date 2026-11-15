// Cards: numbers for a credit card (limit, used, available) or a debit card (balance),
// and the history with what was left after each entry.
import { Dec } from "../engine/decimal.ts";

export type CardKind = "credit" | "debit";
export type TxnKind = "spend" | "payment" | "refund";
export const CARD_COLORS = ["teal", "indigo", "rose", "amber", "slate", "emerald"] as const;
export type CardColor = (typeof CARD_COLORS)[number];

export interface CardRow {
  id: number;
  name: string;
  bank: string;
  kind: CardKind;
  last4: string | null;
  color: CardColor;
  credit_limit: string | null;
  opening_balance: string;
  due_day: number | null;
  created_at: string;
}

export interface TxnRow {
  id: number;
  card_id: number;
  kind: TxnKind;
  amount: string;
  date: string; // YYYY-MM-DD
  note: string;
  created_at: string;
}

export interface HistoryLine {
  txn: TxnRow;
  /** + adds to what you can spend, - takes from it */
  effect: Dec;
  /** available (credit) or balance (debit) right after this entry */
  after: Dec;
}

export interface CardState {
  card: CardRow;
  limit: Dec | null;
  /** credit: amount owed (negative = you paid more than you owed) */
  used: Dec;
  /** credit: limit - used; debit: balance */
  available: Dec;
  /** credit: used / limit as 0..1+ (0 when nothing owed) */
  utilization: number;
  spentThisMonth: Dec;
  inThisMonth: Dec;
  /** newest first */
  history: HistoryLine[];
}

/** Effect of one entry on what you can spend: spends take, payments/deposits and refunds give back. */
export function effectOf(kind: TxnKind, amount: Dec): Dec {
  return kind === "spend" ? amount.neg() : amount;
}

export function cardState(card: CardRow, txns: readonly TxnRow[], month: string): CardState {
  const mine = txns.filter((t) => t.card_id === card.id)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const limit = card.kind === "credit" && card.credit_limit ? Dec.of(card.credit_limit) : null;
  const opening = Dec.of(card.opening_balance);
  // start: credit -> available = limit - already used; debit -> balance
  let left = limit ? limit.minus(opening) : opening;
  let spent = Dec.ZERO;
  let incoming = Dec.ZERO;
  const lines: HistoryLine[] = [];
  for (const t of mine) {
    const amt = Dec.of(t.amount);
    const effect = effectOf(t.kind, amt);
    left = left.plus(effect);
    if (t.date.slice(0, 7) === month) {
      if (t.kind === "spend") spent = spent.plus(amt);
      else incoming = incoming.plus(amt);
    }
    lines.push({ txn: t, effect, after: left });
  }
  const used = limit ? limit.minus(left) : Dec.ZERO;
  const utilization = limit && !limit.isZero() && !used.isNegative() ? used.div(limit).toNumber() : 0;
  return { card, limit, used, available: left, utilization, spentThisMonth: spent, inThisMonth: incoming, history: lines.reverse() };
}

/** Next payment due date (YYYY-MM-DD) for a due day, on or after today; short months use their last day. */
export function nextDue(dueDay: number, today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const make = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    return `${yy}-${String(mm).padStart(2, "0")}-${String(Math.min(dueDay, last)).padStart(2, "0")}`;
  };
  const thisMonth = make(y, m);
  if (Number(thisMonth.slice(8)) >= d) return thisMonth;
  return m === 12 ? make(y + 1, 1) : make(y, m + 1);
}

/** Days from today to a date (both YYYY-MM-DD). */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);
}
