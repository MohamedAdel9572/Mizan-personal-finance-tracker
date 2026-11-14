import { describe, expect, it } from "vitest";
import { normalizeMonth } from "../../ui/monthPicker.ts";

describe("typed months", () => {
  it("accepts common ways of writing a month", () => {
    expect(normalizeMonth("2027-03")).toBe("2027-03");
    expect(normalizeMonth("2027-3")).toBe("2027-03");
    expect(normalizeMonth(" 3/2027 ")).toBe("2027-03");
    expect(normalizeMonth("03-2027")).toBe("2027-03");
    expect(normalizeMonth("2027/11")).toBe("2027-11");
    expect(normalizeMonth("11.2027")).toBe("2027-11");
  });
  it("leaves anything else for the form to reject", () => {
    expect(normalizeMonth("2027-13")).toBe("2027-13");
    expect(normalizeMonth("13/2027")).toBe("13/2027");
    expect(normalizeMonth("March")).toBe("March");
    expect(normalizeMonth("")).toBe("");
  });
});
