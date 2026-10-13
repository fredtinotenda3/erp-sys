import { describe, it, expect } from "vitest";
import { Prisma } from "../../../../generated/prisma/client";
import { buildCurrencyLines, computeProfit } from "../cost-service";
import { capabilitiesFor } from "../../../shared/authz";

const D = (n: string | number) => new Prisma.Decimal(n);

describe("buildCurrencyLines", () => {
  it("keeps currencies separate and never blends them", () => {
    const lines = buildCurrencyLines(
      [{ currency: "USD", estimatedMaterialCost: "40" }, { currency: "ZIG", estimatedMaterialCost: "1000" }],
      [
        { currency: "USD", materialCost: D(50), labourCost: D(12) },
        { currency: "ZIG", materialCost: D(1000), labourCost: null },
      ],
    );
    expect(lines.map((l) => l.currency)).toEqual(["USD", "ZIG"]);
    expect(lines[0].variance.material).toBe("10");
    expect(lines[1].variance.material).toBe("0");
    expect(lines[0].actual.labour).toBe("12");
    expect(lines[1].actual.labour).toBeNull(); // not recorded, not zero
  });

  it("overhead and estimated labour are always unavailable (null), never 0", () => {
    const [l] = buildCurrencyLines([{ currency: "USD", estimatedMaterialCost: "5" }], []);
    expect(l.estimated.overhead).toBeNull();
    expect(l.estimated.labour).toBeNull();
    expect(l.actual.overhead).toBeNull();
  });

  it("no variance where there is no estimate in that currency", () => {
    const [l] = buildCurrencyLines([], [{ currency: "ZAR", materialCost: D(9), labourCost: null }]);
    expect(l.estimated.material).toBeNull();
    expect(l.variance.material).toBeNull();
  });
});

describe("computeProfit", () => {
  const rev = { amount: D(100), currency: "USD" };
  it("computes profit and one-decimal margin when all cost is in the revenue currency", () => {
    const p = computeProfit(rev, [{ currency: "USD", materialCost: D(10), labourCost: D(6) }]);
    expect(p).toMatchObject({ available: true, grossProfit: "84", actualCost: "16", marginPercent: "84", excludesOverhead: true, labourRecorded: true });
  });
  it("is unavailable when cost spans another currency (no silent conversion)", () => {
    const p = computeProfit(rev, [
      { currency: "USD", materialCost: D(10), labourCost: null },
      { currency: "ZIG", materialCost: D(1000), labourCost: null },
    ]);
    expect(p).toEqual({ available: false, reason: "mixed_currencies" });
  });
  it("is unavailable with no quote", () => {
    expect(computeProfit(null, [])).toEqual({ available: false, reason: "no_revenue" });
  });
  it("rounds the margin to one decimal place", () => {
    const p = computeProfit({ amount: D(3), currency: "USD" }, [{ currency: "USD", materialCost: D(1), labourCost: null }]);
    expect(p).toMatchObject({ grossProfit: "2", marginPercent: "66.7", labourRecorded: false });
  });
});

describe("capabilitiesFor", () => {
  it("lists exactly what a role holds", () => {
    expect(capabilitiesFor("PRODUCTION_OPERATOR")).toContain("material:issue");
    expect(capabilitiesFor("PRODUCTION_OPERATOR")).not.toContain("cost:read");
    expect(capabilitiesFor("VIEWER")).not.toContain("cost:read");
    expect(capabilitiesFor("FINANCE_MANAGER")).toContain("exchange_rate:create");
  });
});
