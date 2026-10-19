import { describe, it, expect } from "vitest";
import { Prisma } from "../../../../generated/prisma/client";
import { applyAdjustments, assessCompleteness, computeVariance, explainMaterialVariance } from "../cost-completeness";
import { computeProfit } from "../cost-service";

const D = (v: number | string) => new Prisma.Decimal(v);
const complete = { isFinal: true, hasEstimate: true, unpricedMaterials: [], uncostedConsumptionCount: 0, costedConsumptionCount: 3, labourRecordCount: 2 };

describe("assessCompleteness", () => {
  it("a finished job with every component recorded has no margin blockers and a comparable variance", () => {
    const c = assessCompleteness(complete);
    expect(c.marginBlockers).toEqual([]);
    expect(c.varianceComparable).toBe(true);
    expect(c.overhead).toBe("unavailable");
    // overhead is always named as missing, never silently dropped
    expect(c.missing.map((m) => m.code)).toEqual(["no_overhead_method"]);
  });

  it("an open job can never claim margin or variance", () => {
    const c = assessCompleteness({ ...complete, isFinal: false });
    expect(c.marginBlockers).toContain("job_not_completed");
    expect(c.varianceComparable).toBe(false);
    expect(c.varianceBlocker).toBe("job_in_progress");
  });

  it("names unpriced materials and blocks variance (but not margin: margin uses actual cost)", () => {
    const c = assessCompleteness({ ...complete, unpricedMaterials: [{ materialItemId: "m", reason: "no_standard_cost" }] });
    expect(c.estimate).toBe("incomplete");
    expect(c.missing.some((m) => m.code === "unpriced_materials")).toBe(true);
    expect(c.varianceBlocker).toBe("estimate_incomplete");
    expect(c.marginBlockers).toEqual([]);
  });

  it("uncosted ledger rows are reported, never treated as zero, and block margin and variance", () => {
    const c = assessCompleteness({ ...complete, uncostedConsumptionCount: 2 });
    expect(c.material).toBe("has_uncosted");
    expect(c.marginBlockers).toContain("uncosted_issues");
    expect(c.varianceBlocker).toBe("uncosted_issues");
  });

  it("no labour recorded blocks margin; a labour adjustment counts as recorded", () => {
    expect(assessCompleteness({ ...complete, labourRecordCount: 0 }).marginBlockers).toEqual(["no_labour_recorded"]);
    expect(assessCompleteness({ ...complete, labourRecordCount: 0, hasLabourAdjustment: true }).marginBlockers).toEqual([]);
  });

  it("nothing consumed is 'none recorded', not a free job", () => {
    const c = assessCompleteness({ ...complete, costedConsumptionCount: 0 });
    expect(c.material).toBe("none_recorded");
    expect(c.marginBlockers).toContain("no_material_cost");
  });
});

describe("computeVariance", () => {
  const ok = { varianceComparable: true, varianceBlocker: null };
  it("gives amount and one-decimal percent when comparable", () => {
    expect(computeVariance(D(40), D(50), ok)).toEqual({ amount: "10", percent: "25", comparable: true, reason: null });
    expect(computeVariance(D(30), D(20), ok)).toMatchObject({ amount: "-10", percent: "-33.3" });
  });
  it("withholds the percentage (and says why) when the job is not final", () => {
    const v = computeVariance(D(40), D(10), { varianceComparable: false, varianceBlocker: "job_in_progress" });
    expect(v).toMatchObject({ comparable: false, percent: null, reason: "job_in_progress" });
  });
  it("is not comparable where the currency has no estimate", () => {
    expect(computeVariance(null, D(5), ok)).toEqual({ amount: null, percent: null, comparable: false, reason: "no_estimate_in_currency" });
  });
  it("zero estimate has an amount but no percentage (never divides by zero)", () => {
    expect(computeVariance(D(0), D(5), ok)).toMatchObject({ amount: "5", percent: null, comparable: true });
  });
});

describe("explainMaterialVariance (usage vs price)", () => {
  const base = { expectedQty: D(20), issuedQty: D(25), standardUnitCost: D(2), standardCurrency: "USD", uomMatchesStock: true };
  it("over-issue at standard price is pure usage variance", () => {
    const e = explainMaterialVariance({ ...base, actualCostByCurrency: [{ currency: "USD", cost: D(50) }] });
    expect(e).toMatchObject({ comparable: true, usageVariance: "10", priceVariance: "0", totalVariance: "10", overIssuedQty: "5" });
  });
  it("paying more than standard is price variance", () => {
    const e = explainMaterialVariance({ ...base, issuedQty: D(20), actualCostByCurrency: [{ currency: "USD", cost: D(60) }] });
    expect(e).toMatchObject({ usageVariance: "0", priceVariance: "20", totalVariance: "20", overIssuedQty: "0" });
  });
  it("usage + price always equals the total", () => {
    const e = explainMaterialVariance({ ...base, issuedQty: D(23), actualCostByCurrency: [{ currency: "USD", cost: D(57.5) }] });
    if (!e.comparable) throw new Error("expected comparable");
    expect(D(e.usageVariance).add(D(e.priceVariance)).toString()).toBe(e.totalVariance);
  });
  it("refuses to explain across currencies, units, or without a standard cost", () => {
    expect(explainMaterialVariance({ ...base, actualCostByCurrency: [{ currency: "ZIG", cost: D(500) }] })).toEqual({ comparable: false, reason: "currency_differs" });
    expect(explainMaterialVariance({ ...base, actualCostByCurrency: [{ currency: "USD", cost: D(1) }, { currency: "ZIG", cost: D(1) }] })).toEqual({ comparable: false, reason: "multiple_currencies" });
    expect(explainMaterialVariance({ ...base, uomMatchesStock: false, actualCostByCurrency: [] })).toEqual({ comparable: false, reason: "unit_mismatch" });
    expect(explainMaterialVariance({ ...base, standardUnitCost: null, standardCurrency: null, actualCostByCurrency: [] })).toEqual({ comparable: false, reason: "unpriced" });
  });
  it("nothing issued is a full under-run, explained as usage", () => {
    const e = explainMaterialVariance({ ...base, issuedQty: D(0), actualCostByCurrency: [] });
    expect(e).toMatchObject({ comparable: true, usageVariance: "-40", priceVariance: "0" });
  });
});

describe("applyAdjustments", () => {
  const lines = [{ currency: "USD", materialCost: D(50), labourCost: null as Prisma.Decimal | null }];
  it("adds signed amounts per currency and component", () => {
    const out = applyAdjustments(lines, [
      { currency: "USD", component: "material", amount: D(-5) },
      { currency: "USD", component: "labour", amount: D(12) },
      { currency: "ZIG", component: "material", amount: D(100) },
    ]);
    expect(out.map((l) => [l.currency, l.materialCost.toString(), l.labourCost?.toString() ?? null])).toEqual([
      ["USD", "45", "12"],
      ["ZIG", "100", null],
    ]);
  });
  it("leaves labour unknown (null) when nothing adjusts it", () => {
    expect(applyAdjustments(lines, [{ currency: "USD", component: "material", amount: D(1) }])[0].labourCost).toBeNull();
  });
  it("does not mutate its input", () => {
    applyAdjustments(lines, [{ currency: "USD", component: "material", amount: D(1) }]);
    expect(lines[0].materialCost.toString()).toBe("50");
  });
});

describe("computeProfit gating", () => {
  const rev = { amount: D(100), currency: "USD" };
  const actual = [{ currency: "USD", materialCost: D(10), labourCost: D(6) as Prisma.Decimal | null }];
  it("never reports a margin on a job with no recorded cost (unknown is not free)", () => {
    expect(computeProfit(rev, [])).toMatchObject({ available: false, reason: "no_actual_cost" });
  });
  it("withholds margin while any blocker stands and reports the first as the reason", () => {
    const p = computeProfit(rev, actual, { blockers: ["job_not_completed", "no_labour_recorded"] });
    expect(p).toMatchObject({ available: false, reason: "job_not_completed", blockers: ["job_not_completed", "no_labour_recorded"] });
  });
  it("currency mismatch still wins over completeness reasons", () => {
    const p = computeProfit(rev, [...actual, { currency: "ZIG", materialCost: D(1), labourCost: null }], { blockers: ["job_not_completed"] });
    expect(p).toMatchObject({ available: false, reason: "mixed_currencies" });
  });
  it("labels revenue as a quote and excludes overhead when a margin is stated", () => {
    expect(computeProfit(rev, actual, { blockers: [] })).toMatchObject({ available: true, revenueBasis: "quoted", excludesOverhead: true, grossProfit: "84", marginPercent: "84" });
  });
});
