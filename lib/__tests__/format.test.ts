import { describe, expect, it } from "vitest";
import { formatDecimal, formatMoney, formatQuantity, formatSignedQuantity, formatDate } from "../format";

describe("formatDecimal", () => {
  it("groups thousands without losing precision on large decimal strings", () => {
    expect(formatDecimal("12345678.1234")).toBe("12,345,678.1234");
    expect(formatDecimal("9007199254740993.5")).toBe("9,007,199,254,740,993.5"); // beyond Number precision
  });
  it("trims trailing zeros down to the minimum fraction digits", () => {
    expect(formatDecimal("12.5000")).toBe("12.5");
    expect(formatDecimal("12.0000")).toBe("12");
    expect(formatDecimal("12", { minFraction: 2 })).toBe("12.00");
    expect(formatDecimal("12.5", { minFraction: 2 })).toBe("12.50");
  });
  it("renders null/empty as a dash, never zero", () => {
    expect(formatDecimal(null)).toBe("—");
    expect(formatDecimal(undefined)).toBe("—");
    expect(formatDecimal("")).toBe("—");
  });
  it("returns unparseable input unchanged rather than inventing a number", () => {
    expect(formatDecimal("abc")).toBe("abc");
  });
  it("does not print a negative zero", () => {
    expect(formatDecimal("-0.0000")).toBe("0");
  });
});

describe("formatMoney", () => {
  it("always carries its own currency", () => {
    expect(formatMoney("1234.5", "USD")).toBe("USD 1,234.50");
    expect(formatMoney("10", "ZIG")).toBe("ZIG 10.00");
  });
  it("puts the sign before the currency", () => {
    expect(formatMoney("-31.5", "ZAR")).toBe("-ZAR 31.50");
  });
  it("shows unknown amounts as a dash (never zero)", () => {
    expect(formatMoney(null, "USD")).toBe("—");
  });
});

describe("quantities and dates", () => {
  it("formats quantity with unit", () => {
    expect(formatQuantity("25.0000", "kg")).toBe("25 kg");
    expect(formatQuantity(null, "kg")).toBe("—");
  });
  it("signs ledger quantities", () => {
    expect(formatSignedQuantity("25")).toBe("+25");
    expect(formatSignedQuantity("-4.5")).toBe("−4.5");
  });
  it("shows calendar dates in UTC so they never shift a day", () => {
    expect(formatDate("2026-10-20T00:00:00.000Z")).toBe("20 Oct 2026");
    expect(formatDate(null)).toBe("—");
  });
});
