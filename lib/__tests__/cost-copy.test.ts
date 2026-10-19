import { describe, expect, it } from "vitest";
import { assessCompleteness, explainMaterialVariance, type Completeness } from "../../src/server/modules/costing/cost-completeness";
import { Prisma } from "../../src/generated/prisma/client";
import { EXPLANATION_REASON, PROFIT_REASON, VARIANCE_REASON, COMPONENT_LABEL } from "../cost-copy";

// Every reason code the server can emit must have plain-language copy, so a new
// code can't reach the screen as a raw identifier or an empty explanation.
describe("cost reason copy covers every server reason code", () => {
  const combos: Completeness[] = [];
  for (const isFinal of [true, false])
    for (const hasEstimate of [true, false])
      for (const unpriced of [0, 1])
        for (const uncosted of [0, 2])
          for (const costed of [0, 3])
            for (const labour of [0, 1])
              combos.push(
                assessCompleteness({
                  isFinal,
                  hasEstimate,
                  unpricedMaterials: Array.from({ length: unpriced }, () => ({ materialItemId: "m", reason: "no_standard_cost" })),
                  uncostedConsumptionCount: uncosted,
                  costedConsumptionCount: costed,
                  labourRecordCount: labour,
                }),
              );

  it("margin blockers and profit reasons", () => {
    const codes = new Set(combos.flatMap((c) => c.marginBlockers).concat(["no_revenue", "mixed_currencies", "no_actual_cost"]));
    for (const code of codes) expect(PROFIT_REASON[code], code).toBeTruthy();
  });

  it("variance blockers", () => {
    const codes = new Set(combos.map((c) => c.varianceBlocker).filter((x): x is string => x !== null).concat(["no_estimate_in_currency"]));
    for (const code of codes) expect(VARIANCE_REASON[code], code).toBeTruthy();
  });

  it("material explanation reasons", () => {
    const D = (v: number) => new Prisma.Decimal(v);
    const base = { expectedQty: D(1), issuedQty: D(1), standardUnitCost: D(1), standardCurrency: "USD", uomMatchesStock: true, actualCostByCurrency: [] as { currency: string; cost: Prisma.Decimal }[] };
    const reasons = [
      explainMaterialVariance({ ...base, standardUnitCost: null, standardCurrency: null }),
      explainMaterialVariance({ ...base, uomMatchesStock: false }),
      explainMaterialVariance({ ...base, actualCostByCurrency: [{ currency: "ZIG", cost: D(1) }] }),
      explainMaterialVariance({ ...base, actualCostByCurrency: [{ currency: "USD", cost: D(1) }, { currency: "ZIG", cost: D(1) }] }),
    ].map((e) => (e.comparable ? null : e.reason));
    for (const r of reasons) expect(EXPLANATION_REASON[r as string], String(r)).toBeTruthy();
  });

  it("every missing-component label exists", () => {
    for (const c of combos) for (const m of c.missing) expect(COMPONENT_LABEL[m.component], m.component).toBeTruthy();
  });
});
