// Pure rules for "how complete is this job's cost, and what may we therefore
// claim?" No I/O, so every rule is unit-testable and the same function judges a
// live job, a completion snapshot and the profitability report.
//
// Principles (Phase 2 spec §1):
//  - An unknown cost is never zero. If a component is missing it is named in
//    `missing`, and anything derived from it is withheld, not estimated.
//  - Variance needs BOTH sides to be sufficiently complete and comparable: a
//    job still running has only consumed part of its estimate, so "actual -
//    estimate" there is progress, not variance.
//  - Margin is only for a finished job whose recorded cost is complete in the
//    currency rules; quoted revenue is a quote, not recognised revenue.
import { Prisma } from "../../../generated/prisma/client";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const Z = new Prisma.Decimal(0);

export interface ActualLineLike {
  currency: string;
  materialCost: Prisma.Decimal;
  /** null = no labour recorded in this currency (not "zero"). */
  labourCost: Prisma.Decimal | null;
}

export interface CompletenessInput {
  /** A completion snapshot exists (the job is finished and its cost frozen). */
  isFinal: boolean;
  /** A cost estimate row exists for the job. */
  hasEstimate: boolean;
  unpricedMaterials: { materialItemId: string; reason: string }[];
  /** Consumption/return ledger rows that carry no cost or currency. */
  uncostedConsumptionCount: number;
  /** Ledger rows that carry a cost (consumption + returns). */
  costedConsumptionCount: number;
  labourRecordCount: number;
  /** A labour cost adjustment exists (it counts as recorded labour). */
  hasLabourAdjustment?: boolean;
}

export type MissingComponent = "job" | "estimate" | "material" | "labour" | "overhead";

export interface Missing {
  component: MissingComponent;
  code: string;
  message: string;
}

export interface Completeness {
  isFinal: boolean;
  estimate: "complete" | "incomplete" | "none";
  material: "recorded" | "none_recorded" | "has_uncosted";
  labour: "recorded" | "none_recorded";
  overhead: "unavailable";
  missing: Missing[];
  /** Codes that stop a margin being stated. Empty = margin may be shown (subject to currency rules). */
  marginBlockers: string[];
  /** Estimate vs actual may be compared as a variance. */
  varianceComparable: boolean;
  /** Why not, when varianceComparable is false. */
  varianceBlocker: string | null;
}

export function assessCompleteness(i: CompletenessInput): Completeness {
  const estimate: Completeness["estimate"] = !i.hasEstimate ? "none" : i.unpricedMaterials.length === 0 ? "complete" : "incomplete";
  const material: Completeness["material"] =
    i.uncostedConsumptionCount > 0 ? "has_uncosted" : i.costedConsumptionCount > 0 ? "recorded" : "none_recorded";
  const labour: Completeness["labour"] = i.labourRecordCount > 0 || i.hasLabourAdjustment ? "recorded" : "none_recorded";

  const missing: Missing[] = [];
  if (!i.isFinal) {
    missing.push({ component: "job", code: "job_not_completed", message: "The job is not completed, so actual cost is still accumulating." });
  }
  if (estimate === "none") {
    missing.push({ component: "estimate", code: "no_estimate", message: "No cost estimate exists for this job." });
  } else if (estimate === "incomplete") {
    missing.push({
      component: "estimate",
      code: "unpriced_materials",
      message: `${i.unpricedMaterials.length} material${i.unpricedMaterials.length === 1 ? " has" : "s have"} no usable standard cost, so the material estimate is incomplete.`,
    });
  }
  if (material === "has_uncosted") {
    missing.push({
      component: "material",
      code: "uncosted_issues",
      message: `${i.uncostedConsumptionCount} material movement${i.uncostedConsumptionCount === 1 ? " has" : "s have"} no recorded cost, so actual material cost is understated.`,
    });
  } else if (material === "none_recorded") {
    missing.push({ component: "material", code: "no_material_cost", message: "No material cost has been recorded against this job." });
  }
  if (labour === "none_recorded") {
    missing.push({ component: "labour", code: "no_labour_recorded", message: "No labour has been recorded against this job." });
  }
  missing.push({ component: "overhead", code: "no_overhead_method", message: "Overhead is unavailable: no allocation method has been approved." });

  const marginBlockers: string[] = [];
  if (!i.isFinal) marginBlockers.push("job_not_completed");
  if (material === "has_uncosted") marginBlockers.push("uncosted_issues");
  if (material === "none_recorded") marginBlockers.push("no_material_cost");
  if (labour === "none_recorded") marginBlockers.push("no_labour_recorded");

  let varianceBlocker: string | null = null;
  if (!i.isFinal) varianceBlocker = "job_in_progress";
  else if (estimate !== "complete") varianceBlocker = estimate === "none" ? "no_estimate" : "estimate_incomplete";
  else if (material === "has_uncosted") varianceBlocker = "uncosted_issues";
  else if (material === "none_recorded") varianceBlocker = "no_material_cost";

  return {
    isFinal: i.isFinal,
    estimate,
    material,
    labour,
    overhead: "unavailable",
    missing,
    marginBlockers,
    varianceComparable: varianceBlocker === null,
    varianceBlocker,
  };
}

// ---------------------------------------------------------------------------
// Variance (per currency, material only: labour and overhead have no estimate)
// ---------------------------------------------------------------------------
export interface VarianceResult {
  /** actual - estimated. Present whenever an estimate exists in that currency (kept for compatibility); trust it only when `comparable`. */
  amount: string | null;
  /** (actual - estimated) / estimated, one decimal place. Only when comparable and estimate != 0. */
  percent: string | null;
  comparable: boolean;
  /** Why it isn't comparable. */
  reason: string | null;
}

export function computeVariance(
  estimated: Prisma.Decimal | null,
  actual: Prisma.Decimal,
  completeness: Pick<Completeness, "varianceComparable" | "varianceBlocker">,
): VarianceResult {
  if (estimated === null) {
    // The job-level cause (still running, estimate incomplete...) is the more
    // useful explanation when there is one; otherwise this currency was simply
    // never estimated (cost appeared in a currency the BOM didn't price in).
    return { amount: null, percent: null, comparable: false, reason: completeness.varianceComparable ? "no_estimate_in_currency" : completeness.varianceBlocker };
  }
  const amount = actual.sub(estimated);
  if (!completeness.varianceComparable) {
    return { amount: amount.toString(), percent: null, comparable: false, reason: completeness.varianceBlocker };
  }
  return {
    amount: amount.toString(),
    percent: estimated.isZero() ? null : amount.div(estimated).mul(100).toDecimalPlaces(1).toString(),
    comparable: true,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Explaining a material variance: usage (quantity) vs price
//   usage = (issued - expected) x standard cost
//   price = actual cost - issued x standard cost
//   total = usage + price = actual cost - expected x standard cost
// Only when the standard cost and every actual cost are in ONE currency and
// the units match; otherwise it says exactly why it can't be explained.
// ---------------------------------------------------------------------------
export interface MaterialExplainInput {
  expectedQty: Prisma.Decimal;
  /** Net consumed (issues less returns). */
  issuedQty: Prisma.Decimal;
  actualCostByCurrency: { currency: string; cost: Prisma.Decimal }[];
  standardUnitCost: Prisma.Decimal | null;
  standardCurrency: string | null;
  uomMatchesStock: boolean;
}

export type MaterialExplanation =
  | { comparable: false; reason: "unpriced" | "unit_mismatch" | "currency_differs" | "multiple_currencies" }
  | {
      comparable: true;
      currency: string;
      expectedCost: string;
      actualCost: string;
      usageVariance: string;
      priceVariance: string;
      totalVariance: string;
      overIssuedQty: string;
    };

export function explainMaterialVariance(i: MaterialExplainInput): MaterialExplanation {
  if (i.standardUnitCost === null || !i.standardCurrency) return { comparable: false, reason: "unpriced" };
  if (!i.uomMatchesStock) return { comparable: false, reason: "unit_mismatch" };
  if (i.actualCostByCurrency.length > 1) return { comparable: false, reason: "multiple_currencies" };
  const actualCurrency = i.actualCostByCurrency[0]?.currency;
  if (actualCurrency && actualCurrency !== i.standardCurrency) return { comparable: false, reason: "currency_differs" };

  const actualCost = i.actualCostByCurrency[0]?.cost ?? Z;
  const expectedCost = i.expectedQty.mul(i.standardUnitCost);
  const usage = i.issuedQty.sub(i.expectedQty).mul(i.standardUnitCost);
  const price = actualCost.sub(i.issuedQty.mul(i.standardUnitCost));
  return {
    comparable: true,
    currency: i.standardCurrency,
    expectedCost: expectedCost.toString(),
    actualCost: actualCost.toString(),
    usageVariance: usage.toString(),
    priceVariance: price.toString(),
    totalVariance: actualCost.sub(expectedCost).toString(),
    overIssuedQty: Prisma.Decimal.max(i.issuedQty.sub(i.expectedQty), 0).toString(),
  };
}

// ---------------------------------------------------------------------------
// Adjustments: effective actual = snapshot + signed adjustments, per currency.
// ---------------------------------------------------------------------------
export interface AdjustmentLike {
  currency: string;
  component: "material" | "labour";
  amount: Prisma.Decimal;
}

export function applyAdjustments(lines: ActualLineLike[], adjustments: AdjustmentLike[]): ActualLineLike[] {
  const byCurrency = new Map<string, ActualLineLike>(lines.map((l) => [l.currency, { ...l }]));
  for (const a of adjustments) {
    const cur = byCurrency.get(a.currency) ?? { currency: a.currency, materialCost: Z, labourCost: null };
    if (a.component === "material") cur.materialCost = cur.materialCost.add(a.amount);
    // a labour adjustment turns "none recorded" (null) into a recorded figure
    else cur.labourCost = (cur.labourCost ?? Z).add(a.amount);
    byCurrency.set(a.currency, cur);
  }
  return [...byCurrency.values()].sort((x, y) => x.currency.localeCompare(y.currency));
}

export { D as toDecimal };
