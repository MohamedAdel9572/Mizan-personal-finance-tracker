/**
 * The plan editor works on a Draft: a plain, editable copy of a plan version.
 * validateDraft() mirrors the checks in save_plan_version() so most mistakes
 * are caught before the request; the database checks again anyway.
 */
import { Dec } from "../engine/decimal.ts";
import { addMonths, isMonth, type Month } from "../engine/month.ts";
import type { ItemKind, PlanVersion, Recurrence } from "../engine/types.ts";

export interface DraftAmount {
  month: string;
  amount: string;
}

export interface DraftItem {
  /** stable line key; empty for a new line (the database creates one) */
  key: string;
  kind: ItemKind;
  name: string;
  recurrence: Recurrence;
  start: string;
  end: string;
  amounts: DraftAmount[];
}

export interface Draft {
  start: string;
  horizonMonths: string;
  openingBalance: string;
  rates: { from: string; rate: string }[];
  items: DraftItem[];
}

const AMOUNT_RE = /^\d{1,14}(\.\d{1,2})?$/;
const RATE_RE = /^\d{1,3}(\.\d{1,4})?$/;

/** "28,000" -> "28000"; keeps anything else as typed so validation can complain. */
export function cleanAmount(s: string): string {
  return s.trim().replace(/[,\s]/g, "");
}

export function emptyDraft(start: Month): Draft {
  return {
    start,
    horizonMonths: "24",
    openingBalance: "",
    rates: [{ from: start, rate: "" }],
    items: [],
  };
}

export function newItem(kind: ItemKind, month: Month): DraftItem {
  return { key: "", kind, name: "", recurrence: "recurring", start: month, end: "", amounts: [{ month, amount: "" }] };
}

export function draftFromVersion(v: PlanVersion): Draft {
  return {
    start: v.start,
    horizonMonths: String(v.horizonMonths),
    openingBalance: Dec.of(v.openingBalance).toString(),
    rates: v.rates.map((r) => ({ from: r.from, rate: Dec.of(r.annualRatePct).toString() })),
    items: v.items.map((i) => ({
      key: i.key,
      kind: i.kind,
      name: i.name,
      recurrence: i.recurrence,
      start: i.start,
      end: i.end ?? "",
      amounts: [...i.amounts]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((a) => ({ month: a.month, amount: Dec.of(a.amount).toString() })),
    })),
  };
}

export interface DraftProblem {
  /** index of the line, or null for plan-level problems */
  item: number | null;
  message: string;
}

export function validateDraft(d: Draft): DraftProblem[] {
  const out: DraftProblem[] = [];
  const add = (item: number | null, message: string) => out.push({ item, message });

  if (!isMonth(d.start)) add(null, "Start month is not valid.");
  const horizon = Number(d.horizonMonths);
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 240) add(null, "Horizon must be 1 to 240 months.");
  // opening savings and interest are optional: empty = 0
  if (!AMOUNT_RE.test(cleanAmount(d.openingBalance) || "0")) add(null, "Opening balance must be a number of 0 or more (max 2 decimals).");

  if (d.rates.length === 0) add(null, "Add the savings account interest rate.");
  const rateMonths = new Set<string>();
  d.rates.forEach((r) => {
    if (!isMonth(r.from)) add(null, "Every rate needs a valid month.");
    else if (isMonth(d.start) && r.from < d.start) add(null, `Rate change ${r.from} is before the plan start.`);
    if (!RATE_RE.test(r.rate.trim() || "0") || Number(r.rate) > 100) add(null, `Interest rate "${r.rate}" must be 0 to 100.`);
    if (rateMonths.has(r.from)) add(null, `Two interest rates start in ${r.from}.`);
    rateMonths.add(r.from);
  });
  if (isMonth(d.start) && d.rates.length && !d.rates.some((r) => r.from === d.start)) {
    add(null, `The first interest rate must start in the plan start month (${d.start}).`);
  }

  d.items.forEach((item, i) => {
    const label = item.name.trim() ? `"${item.name.trim()}"` : `Line ${i + 1}`;
    if (!item.name.trim()) add(i, `Line ${i + 1}: name is required.`);
    else if (item.name.trim().length > 80) add(i, `${label}: name is too long (max 80).`);
    if (item.kind === "asset" && item.recurrence !== "recurring") add(i, `${label}: assets must be recurring.`);
    if (item.amounts.length === 0) add(i, `${label}: add at least one amount.`);

    const months = new Set<string>();
    item.amounts.forEach((a) => {
      if (!isMonth(a.month)) add(i, `${label}: every amount needs a valid month.`);
      if (!AMOUNT_RE.test(cleanAmount(a.amount))) add(i, `${label}: "${a.amount}" is not a valid amount (0 or more, max 2 decimals).`);
      if (months.has(a.month)) add(i, `${label}: two amounts for ${a.month}.`);
      months.add(a.month);
    });

    if (item.recurrence === "recurring") {
      if (!isMonth(item.start)) add(i, `${label}: start month is not valid.`);
      if (item.end && !isMonth(item.end)) add(i, `${label}: end month is not valid.`);
      if (isMonth(item.start) && isMonth(item.end) && item.end < item.start) add(i, `${label}: end month is before the start month.`);
      if (isMonth(item.start) && isMonth(d.start) && item.start < d.start) add(i, `${label}: starts before the plan start month.`);
      if (isMonth(item.start) && !item.amounts.some((a) => a.month === item.start)) {
        add(i, `${label}: the first amount must be in the start month (${item.start}).`);
      }
      item.amounts.forEach((a) => {
        if (isMonth(a.month) && ((isMonth(item.start) && a.month < item.start) || (isMonth(item.end) && a.month > item.end))) {
          add(i, `${label}: amount month ${a.month} is outside the line's months.`);
        }
      });
    } else if (isMonth(d.start) && item.amounts.some((a) => isMonth(a.month) && a.month < d.start)) {
      add(i, `${label}: starts before the plan start month.`);
    }
  });
  return out;
}

/** Payload for save_plan_version(). Call only after validateDraft() returned nothing. */
export function draftToPayload(d: Draft, effectiveFrom: Month, note: string): Record<string, unknown> {
  return {
    start_month: d.start,
    effective_from: effectiveFrom,
    horizon_months: Number(d.horizonMonths),
    opening_balance: cleanAmount(d.openingBalance) || "0",
    note,
    rates: d.rates.map((r) => ({ from: r.from, annual_rate_pct: r.rate.trim() || "0" })),
    items: d.items.map((i) => {
      const amounts = i.amounts.map((a) => ({ month: a.month, amount: cleanAmount(a.amount) }));
      return {
        ...(i.key ? { item_key: i.key } : {}),
        kind: i.kind,
        name: i.name.trim(),
        recurrence: i.recurrence,
        ...(i.recurrence === "recurring" ? { start: i.start, end: i.end || null } : {}),
        amounts,
      };
    }),
  };
}

/** Default "effective from" for a new version: this month, but never before the current version or the plan start. */
/** Default "use this version from": this month, but not before the plan starts. (latestEffective is no longer a lower bound.) */
export function defaultEffective(current: Month, _latestEffective: Month | null, planStart: Month): Month {
  return current < planStart ? planStart : current;
}

export function lastPlanMonth(d: Draft): Month | null {
  const h = Number(d.horizonMonths);
  return isMonth(d.start) && Number.isInteger(h) && h >= 1 ? addMonths(d.start, h - 1) : null;
}
