import { Dec } from "./decimal.ts";
import { addMonths, assertMonth, monthIndex, type Month } from "./month.ts";
import type { PlanItem, PlanMonth, PlanVersion } from "./types.ts";

const TWELVE_HUNDRED = Dec.of(1200); // annual % -> monthly fraction: rate / 100 / 12

/** Amount of one line in one month. */
export function itemAmount(item: PlanItem, m: Month): Dec {
  if (item.recurrence === "one_off") {
    return Dec.sum(item.amounts.filter((a) => a.month === m).map((a) => a.amount));
  }
  if (m < item.start || (item.end && m > item.end)) return Dec.ZERO;
  // step function: the latest change on or before m
  let current: Dec = Dec.ZERO;
  let currentMonth = "";
  for (const a of item.amounts) {
    if (a.month <= m && a.month >= currentMonth) {
      current = Dec.of(a.amount);
      currentMonth = a.month;
    }
  }
  return current;
}

/** Annual rate in percent active in month m (0 before the first rate). */
export function rateAt(version: PlanVersion, m: Month): Dec {
  let rate: Dec = Dec.ZERO;
  let from = "";
  for (const r of version.rates) {
    if (r.from <= m && r.from >= from) {
      rate = Dec.of(r.annualRatePct);
      from = r.from;
    }
  }
  return rate;
}

/**
 * Interest(m) = Balance(m-1) x annualRate / 12  (rate given in percent).
 * Zero when the previous balance is zero or negative: a savings account doesn't
 * charge its savings rate on an overdraft, so the plain formula would invent a cost.
 */
export function monthlyInterest(previousBalance: Dec, annualRatePct: Dec): Dec {
  if (!previousBalance.gt(0)) return Dec.ZERO;
  return previousBalance.times(annualRatePct).div(TWELVE_HUNDRED);
}

export function planEnd(version: PlanVersion): Month {
  return addMonths(version.start, version.horizonMonths - 1);
}

/**
 * Month-by-month projection of one plan version.
 *   Net(m)     = Income(m) - Expenses(m)
 *   first:     Balance = Opening + Net
 *   later:     Interest = Balance(m-1) x rate / 12;  Balance = Balance(m-1) + Interest + Net
 *   NetWorth   = Balance + assets
 * `until` may go past the horizon (used to find the goal date); lines without
 * an end month simply continue.
 */
export function projectPlan(version: PlanVersion, until: Month = planEnd(version)): PlanMonth[] {
  assertMonth(until, "until");
  const out: PlanMonth[] = [];
  let balance = Dec.of(version.openingBalance);
  const count = monthIndex(until) - monthIndex(version.start) + 1;

  for (let i = 0; i < count; i++) {
    const month = addMonths(version.start, i);
    const lines = new Map<string, Dec>();
    let income = Dec.ZERO;
    let expenses = Dec.ZERO;
    let assets = Dec.ZERO;
    for (const item of version.items) {
      const amount = itemAmount(item, month);
      lines.set(item.key, amount);
      if (item.kind === "income") income = income.plus(amount);
      else if (item.kind === "expense") expenses = expenses.plus(amount);
      else assets = assets.plus(amount);
    }
    const net = income.minus(expenses);
    const annualRatePct = rateAt(version, month);
    const known = version.knownInterest?.[month];
    const interest = known != null ? Dec.of(known) : i === 0 ? Dec.ZERO : monthlyInterest(balance, annualRatePct);
    balance = balance.plus(interest).plus(net);
    out.push({
      month,
      lines,
      income,
      expenses,
      net,
      annualRatePct,
      interest,
      balance,
      assets,
      netWorth: balance.plus(assets),
    });
  }
  return out;
}

/**
 * The version in force in month m: the newest version (highest number) whose "from" month
 * has started. A newer save wins from its month onward, also over an older version that
 * started later.
 */
export function versionFor(versions: readonly PlanVersion[], m: Month): PlanVersion | undefined {
  let best: PlanVersion | undefined;
  for (const v of versions) {
    if (v.effectiveFrom > m) continue;
    if (!best || v.versionNo > best.versionNo) best = v;
  }
  return best;
}

/**
 * All plan versions together. planned(m) answers "what did the plan say for
 * month m" using the version active in m. Projections are cached per version.
 */
export class PlanTimeline {
  readonly versions: readonly PlanVersion[];
  private readonly cache = new Map<number, PlanMonth[]>();
  private readonly names = new Map<string, { name: string; kind: PlanItem["kind"] }>();

  constructor(versions: readonly PlanVersion[]) {
    if (versions.length === 0) throw new RangeError("No plan versions");
    this.versions = [...versions].sort((a, b) => a.versionNo - b.versionNo);
    for (const v of this.versions) {
      for (const item of v.items) this.names.set(item.key, { name: item.name, kind: item.kind });
    }
  }

  get first(): PlanVersion {
    return this.versions[0]!;
  }

  get latest(): PlanVersion {
    return this.versions[this.versions.length - 1]!;
  }

  /** First month any version covers. */
  get start(): Month {
    return this.first.start;
  }

  versionFor(m: Month): PlanVersion | undefined {
    return versionFor(this.versions, m);
  }

  /** Name and kind of a line, from the newest version that has it. */
  lineInfo(key: string): { name: string; kind: PlanItem["kind"] } | undefined {
    return this.names.get(key);
  }

  planned(m: Month): PlanMonth | undefined {
    const v = this.versionFor(m);
    if (!v || m < v.start) return undefined;
    return this.projection(v, m)[monthIndex(m) - monthIndex(v.start)];
  }

  private projection(v: PlanVersion, atLeastUntil: Month): PlanMonth[] {
    const cached = this.cache.get(v.versionNo);
    const last = cached?.[cached.length - 1]?.month;
    if (cached && last && last >= atLeastUntil) return cached;
    // grow in yearly steps so a long goal search doesn't recompute every month
    const target = atLeastUntil > planEnd(v) ? addMonths(atLeastUntil, 12) : planEnd(v);
    const rows = projectPlan(v, target);
    this.cache.set(v.versionNo, rows);
    return rows;
  }
}

/** Shape returned by the get_plan_versions() RPC. */
export interface PlanVersionRow {
  version_no: number;
  effective_from: string;
  start_month: string;
  horizon_months: number;
  opening_balance: string;
  rates: { from: string; annual_rate_pct: string }[];
  items: {
    item_key: string;
    kind: PlanItem["kind"];
    name: string;
    recurrence: PlanItem["recurrence"];
    start: string;
    end: string | null;
    amounts: { month: string; amount: string }[];
  }[];
}

export function versionFromRow(row: PlanVersionRow): PlanVersion {
  return {
    versionNo: row.version_no,
    effectiveFrom: assertMonth(row.effective_from, "effective_from"),
    start: assertMonth(row.start_month, "start_month"),
    horizonMonths: row.horizon_months,
    openingBalance: row.opening_balance,
    rates: row.rates.map((r) => ({ from: assertMonth(r.from, "rate month"), annualRatePct: r.annual_rate_pct })),
    items: row.items.map((i) => ({
      key: i.item_key,
      kind: i.kind,
      name: i.name,
      recurrence: i.recurrence,
      start: assertMonth(i.start, "item start"),
      end: i.end ? assertMonth(i.end, "item end") : null,
      amounts: i.amounts.map((a) => ({ month: assertMonth(a.month, "amount month"), amount: a.amount })),
    })),
  };
}
