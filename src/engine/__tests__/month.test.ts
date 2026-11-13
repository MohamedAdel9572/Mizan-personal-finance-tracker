import { describe, expect, it } from "vitest";
import { addMonths, currentMonth, isMonth, monthRange, monthsBetween } from "../month.ts";

describe("months", () => {
  it("validates YYYY-MM", () => {
    expect(isMonth("2026-11")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-1")).toBe(false);
    expect(isMonth("2026-11-01")).toBe(false);
  });

  it("does month arithmetic across years", () => {
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(addMonths("2027-01", -2)).toBe("2026-11");
    expect(monthsBetween("2026-11", "2028-12")).toBe(25);
    expect(monthRange("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });

  it("uses Cairo time for the current month", () => {
    // 2026-11-30 23:30 UTC is already 2026-12-01 in Cairo (UTC+2)
    expect(currentMonth(new Date("2026-11-30T23:30:00Z"))).toBe("2026-12");
  });
});
