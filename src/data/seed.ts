import type { PlanVersion } from "../engine/types.ts";

/**
 * The numbers from the Excel sheet, used to check the engine against Excel and
 * later as the "load my sample plan" option. Keys are fixed so tests are stable.
 */
export const SEED_PLAN: PlanVersion = {
  versionNo: 1,
  effectiveFrom: "2026-11",
  start: "2026-11",
  horizonMonths: 24,
  openingBalance: "100000",
  rates: [{ from: "2026-11", annualRatePct: "17" }],
  items: [
    {
      key: "salary", kind: "income", name: "Salary", recurrence: "recurring", start: "2026-11",
      amounts: [
        { month: "2026-11", amount: "28000" },
        { month: "2027-03", amount: "35000" },
        { month: "2028-03", amount: "43750" },
      ],
    },
    {
      key: "bonus", kind: "income", name: "Bonus", recurrence: "one_off", start: "2026-12", end: "2028-03",
      amounts: [
        { month: "2026-12", amount: "32000" },
        { month: "2027-03", amount: "300000" },
        { month: "2027-08", amount: "17500" },
        { month: "2027-12", amount: "35000" },
        { month: "2028-03", amount: "500000" },
      ],
    },
    {
      key: "car", kind: "expense", name: "Car", recurrence: "recurring", start: "2026-11",
      amounts: [
        { month: "2026-11", amount: "5300" },
        { month: "2027-03", amount: "8000" },
      ],
    },
    { key: "ps5", kind: "expense", name: "PS5", recurrence: "recurring", start: "2026-12", end: "2027-11",
      amounts: [{ month: "2026-12", amount: "3000" }] },
    { key: "uber", kind: "expense", name: "Uber", recurrence: "recurring", start: "2026-11",
      amounts: [{ month: "2026-11", amount: "3500" }] },
    { key: "doctor", kind: "expense", name: "Doctor", recurrence: "recurring", start: "2026-11", end: "2026-12",
      amounts: [{ month: "2026-11", amount: "6000" }] },
    { key: "lifestyle", kind: "expense", name: "Lifestyle", recurrence: "recurring", start: "2026-11",
      amounts: [{ month: "2026-11", amount: "10000" }] },
    { key: "tablet", kind: "expense", name: "Tablet", recurrence: "recurring", start: "2026-11", end: "2027-02",
      amounts: [{ month: "2026-11", amount: "960" }] },
    { key: "gold", kind: "asset", name: "Gold", recurrence: "recurring", start: "2026-11",
      amounts: [{ month: "2026-11", amount: "100000" }] },
  ],
};
