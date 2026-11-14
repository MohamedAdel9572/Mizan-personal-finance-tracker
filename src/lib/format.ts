import { Dec, type DecimalInput } from "../engine/decimal.ts";
import type { Month } from "../engine/month.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1,234,567" or "1,234,567.50". Works on the exact decimal string, never a float. */
export function money(value: DecimalInput, decimals = 0): string {
  const s = Dec.of(value).toFixed(decimals);
  const neg = s.startsWith("-");
  const [int = "0", frac] = s.replace("-", "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? "." + frac : "");
}

export function egp(value: DecimalInput, decimals = 0): string {
  return `${money(value, decimals)} EGP`;
}

/** "+1,200" / "-300" / "0" */
export function signed(value: DecimalInput, decimals = 0): string {
  const d = Dec.of(value);
  const s = money(d, decimals);
  return d.gt(0) && s !== "0" ? "+" + s : s;
}

export function pct(ratio: Dec, decimals = 0): string {
  return `${ratio.times(100).toFixed(decimals)}%`;
}

export function monthLabel(m: Month, long = false): string {
  const name = MONTHS[Number(m.slice(5, 7)) - 1] ?? "?";
  return long ? `${name} ${m.slice(0, 4)}` : `${name} ${m.slice(2, 4)}`;
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
