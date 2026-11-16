import { describe, expect, it } from "vitest";
import { cleanNumber } from "../../ui/numberInputs.ts";

describe("number boxes", () => {
  it("percent: digits and one point, 2 decimals, 3 whole digits", () => {
    expect(cleanNumber("5dcccccccc%cccc", "pct")).toBe("5");
    expect(cleanNumber("7.5", "pct")).toBe("7.5");
    expect(cleanNumber("7.555", "pct")).toBe("7.55");
    expect(cleanNumber("1.2.3", "pct")).toBe("1.23");
    expect(cleanNumber("12345", "pct")).toBe("123");
    expect(cleanNumber("-5", "pct")).toBe("5");
    expect(cleanNumber("5,5", "pct")).toBe("55");
  });
  it("signed percent keeps a leading + or -", () => {
    expect(cleanNumber("-1.3", "signed-pct")).toBe("-1.3");
    expect(cleanNumber("+1.30%", "signed-pct")).toBe("+1.30");
    expect(cleanNumber("1-3", "signed-pct")).toBe("13");
  });
  it("money keeps thousands commas, 2 decimals", () => {
    expect(cleanNumber("12,510.75 EGP", "money")).toBe("12,510.75");
    expect(cleanNumber("1.005", "money")).toBe("1.00");
    expect(cleanNumber("abc", "money")).toBe("");
  });
  it("grams allow 3 decimals", () => {
    expect(cleanNumber("2.1255g", "grams")).toBe("2.125");
  });
  it("signed money and rates", () => {
    expect(cleanNumber("-800", "signed-money")).toBe("-800");
    expect(cleanNumber("−1,250.555", "signed-money")).toBe("-1,250.55");
    expect(cleanNumber("+abc12", "signed-money")).toBe("+12");
    expect(cleanNumber("0.04657", "rate")).toBe("0.0465");
    expect(cleanNumber("-17%", "rate")).toBe("17");
  });
});
