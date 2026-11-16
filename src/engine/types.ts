import type { Dec } from "./decimal.ts";
import type { Month } from "./month.ts";

/** Money values come in as strings (exact) from get_plan_versions(). */
export type Money = string;

export type ItemKind = "income" | "expense" | "asset";
export type Recurrence = "recurring" | "one_off";

export interface AmountPoint {
  /** recurring: amount applies from this month on; one_off: happens in this month */
  month: Month;
  amount: Money;
}

export interface PlanItem {
  key: string;
  kind: ItemKind;
  name: string;
  recurrence: Recurrence;
  start: Month;
  /** inclusive; null = no end */
  end?: Month | null;
  amounts: AmountPoint[];
}

export interface RatePoint {
  from: Month;
  /** annual rate in percent, e.g. "17" = 17% */
  annualRatePct: Money;
}

export interface PlanVersion {
  versionNo: number;
  /** months >= effectiveFrom are compared against this version */
  effectiveFrom: Month;
  start: Month;
  horizonMonths: number;
  openingBalance: Money;
  rates: RatePoint[];
  items: PlanItem[];
}

export interface PlanMonth {
  month: Month;
  /** amount per line (income, expense and asset lines) */
  lines: Map<string, Dec>;
  income: Dec;
  expenses: Dec;
  net: Dec;
  annualRatePct: Dec;
  interest: Dec;
  balance: Dec;
  /** value of asset lines (gold, other assets) */
  assets: Dec;
  netWorth: Dec;
}

export interface Checkin {
  month: Month;
  /** real bank balance; when given it replaces the computed balance */
  savingsBalance?: Money | null;
}

export interface ActualEntry {
  month: Month;
  itemKey: string;
  amount: Money;
}

export interface UnplannedItem {
  month: Month;
  kind: "income" | "expense";
  name: string;
  amount: Money;
}

export interface ActualsInput {
  checkins: Checkin[];
  entries: ActualEntry[];
  unplanned: UnplannedItem[];
  /** month -> value of assets at month end (gold at that month's price + other assets) */
  assetValues?: Record<Month, Money>;
  /** month -> real interest (total profit/loss of your investments that month); replaces the rate formula */
  interest?: Record<Month, Money>;
}

export interface ActualMonth {
  month: Month;
  /** true = not checked in; planned values were assumed to keep the balance chain going */
  assumed: boolean;
  lines: Map<string, Dec>;
  unplanned: UnplannedItem[];
  income: Dec;
  expenses: Dec;
  net: Dec;
  interest: Dec;
  balance: Dec;
  /** true when balance came from the user's check-in instead of the formula */
  balanceReported: boolean;
  assets: Dec;
  netWorth: Dec;
}
