/**
 * Months are plain "YYYY-MM" strings everywhere in the app. Zero-padded, so
 * normal string comparison (<, >, sort) gives calendar order.
 */
export type Month = string;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is Month {
  return typeof value === "string" && MONTH_RE.test(value);
}

export function assertMonth(value: unknown, field = "month"): Month {
  if (!isMonth(value)) throw new RangeError(`${field}: "${String(value)}" is not a valid month (YYYY-MM)`);
  return value;
}

/** Months since year 0; makes arithmetic simple. */
export function monthIndex(m: Month): number {
  assertMonth(m);
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
}

export function fromIndex(index: number): Month {
  const y = Math.floor(index / 12);
  const mo = (index % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}`;
}

export function addMonths(m: Month, n: number): Month {
  return fromIndex(monthIndex(m) + n);
}

/** Number of months from a to b (b - a). */
export function monthsBetween(a: Month, b: Month): number {
  return monthIndex(b) - monthIndex(a);
}

/** Inclusive range. */
export function monthRange(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i++) out.push(fromIndex(i));
  return out;
}

export function maxMonth(a: Month, b: Month): Month {
  return a >= b ? a : b;
}

export function minMonth(a: Month, b: Month): Month {
  return a <= b ? a : b;
}

/** Current month in Cairo, so the app agrees with the database rule. */
export function currentMonth(now = new Date(), timeZone = "Africa/Cairo"): Month {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return assertMonth(`${y}-${m}`, "currentMonth");
}
