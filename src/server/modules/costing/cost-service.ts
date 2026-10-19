// Cost views: one job's estimate vs actual (with variance), a batch summary for
// the job list, and the profitability report.
//
// Rules enforced here (UX spec §7.0 / ARCHITECTURE.md §9):
//  - NEVER sum across currencies. Everything is per currency.
//  - Overhead is always null = UNAVAILABLE (no allocation method approved).
//  - A converted total is opt-in, and always cites the exact ExchangeRate row
//    used (rate, as-of date, source). If any currency has no rate, no total
//    is produced at all.
//  - Variance is only reported where an estimate exists in that currency, and
//    is flagged unreliable when some materials could not be priced.
//  - A completed job reads its frozen snapshot; an open job reads live data.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, assertBranchAccess, hasCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "../production/job-service";
import { computeActualCostLines, computeActualMaterialByItem, computeConsumptionEvidence, type ActualCostLine } from "./actual-cost";
import { findLatestRate, findRateAsOf, type RateSourceValue } from "./exchange-rate-service";
import { applyAdjustments, assessCompleteness, computeVariance, explainMaterialVariance, type AdjustmentLike, type Completeness } from "./cost-completeness";
import { listAdjustments, adjustmentToView } from "./cost-adjustment-service";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const Z = new Prisma.Decimal(0);

export interface CurrencyCostLine {
  currency: string;
  estimated: { material: string | null; labour: null; overhead: null };
  actual: { material: string; labour: string | null; overhead: null };
  variance: { material: string | null };
}

export interface EstimateRow { currency: string; estimatedMaterialCost: unknown }

export function buildCurrencyLines(estimate: EstimateRow[], actual: ActualCostLine[]): CurrencyCostLine[] {
  const currencies = [...new Set([...estimate.map((e) => e.currency.trim()), ...actual.map((a) => a.currency)])].sort();
  return currencies.map((c) => {
    const e = estimate.find((x) => x.currency.trim() === c);
    const a = actual.find((x) => x.currency === c);
    const estMaterial = e ? D(e.estimatedMaterialCost) : null;
    const actMaterial = a ? a.materialCost : Z;
    return {
      currency: c,
      estimated: { material: estMaterial ? estMaterial.toString() : null, labour: null, overhead: null },
      actual: { material: actMaterial.toString(), labour: a?.labourCost ? a.labourCost.toString() : null, overhead: null },
      // actual - estimated: positive = over estimate.
      variance: { material: estMaterial ? actMaterial.sub(estMaterial).toString() : null },
    };
  });
}

// Gross profit (before overhead) is stated only when ALL of these hold:
//  - there is a quote to measure against (and it is labelled a QUOTE: it is not
//    recognised revenue -- nothing here books or invoices it);
//  - every recorded cost is in the quote's currency (no silent conversion);
//  - some actual cost exists (a job with nothing recorded is "unknown", not
//    "free"), and -- when a completeness gate is supplied -- the job is
//    finished and its cost components are complete (no uncosted issues, labour
//    recorded). The pure two-argument form keeps its original behaviour for
//    callers/tests that do not carry completeness.
export type ProfitUnavailableReason = "no_revenue" | "mixed_currencies" | "no_actual_cost" | string;

export function computeProfit(
  revenue: { amount: Prisma.Decimal; currency: string } | null,
  actual: ActualCostLine[],
  gate?: { blockers: string[] },
) {
  if (!revenue) return { available: false as const, reason: "no_revenue" as ProfitUnavailableReason };
  if (actual.some((a) => a.currency !== revenue.currency)) {
    return { available: false as const, reason: "mixed_currencies" as ProfitUnavailableReason };
  }
  if (actual.length === 0) return { available: false as const, reason: "no_actual_cost" as ProfitUnavailableReason, blockers: ["no_actual_cost"] };
  if (gate && gate.blockers.length > 0) {
    return { available: false as const, reason: gate.blockers[0] as ProfitUnavailableReason, blockers: gate.blockers };
  }
  const a = actual[0];
  return profit(revenue, a.materialCost.add(a.labourCost ?? Z), a.labourCost !== null);
}

function profit(revenue: { amount: Prisma.Decimal; currency: string }, cost: Prisma.Decimal, labourRecorded: boolean) {
  const gross = revenue.amount.sub(cost);
  return {
    available: true as const,
    currency: revenue.currency,
    revenue: revenue.amount.toString(),
    // Stated so no screen can present a quote as recognised revenue.
    revenueBasis: "quoted" as const,
    actualCost: cost.toString(),
    grossProfit: gross.toString(),
    marginPercent: revenue.amount.isZero() ? null : gross.div(revenue.amount).mul(100).toDecimalPlaces(1).toString(),
    // Both always true today; stated so the UI never presents this as full cost.
    excludesOverhead: true as const,
    labourRecorded,
  };
}

interface FrozenSnapshot {
  snapshottedAt: Date;
  revenue: Prisma.Decimal | null;
  revenueCurrency: string | null;
  completeness: unknown;
  evidence: Record<string, unknown>;
}

async function loadActual(
  orgId: string,
  job: { id: string; status: string },
): Promise<{ basis: "snapshot" | "live"; lines: ActualCostLine[]; snapshotAt: Date | null; snapshot: FrozenSnapshot | null }> {
  if (job.status === "completed" || job.status === "closed") {
    const snap = await prisma.jobCostActual.findUnique({ where: { jobId: job.id } });
    if (snap) {
      const rows = await prisma.jobCostActualLine.findMany({ where: { orgId, jobId: job.id }, orderBy: { currency: "asc" } });
      return {
        basis: "snapshot",
        snapshotAt: snap.snapshottedAt,
        snapshot: {
          snapshottedAt: snap.snapshottedAt,
          revenue: snap.revenue === null ? null : D(snap.revenue),
          revenueCurrency: snap.revenueCurrency ? snap.revenueCurrency.trim() : null,
          completeness: snap.completeness,
          evidence: (snap.evidence ?? {}) as Record<string, unknown>,
        },
        lines: rows.map((r) => ({
          currency: r.currency.trim(),
          materialCost: D(r.actualMaterialCost),
          labourCost: r.actualLabourCost === null ? null : D(r.actualLabourCost),
        })),
      };
    }
  }
  const live = await computeActualCostLines(prisma, orgId, [job.id]);
  return { basis: "live", snapshotAt: null, snapshot: null, lines: live.get(job.id) ?? [] };
}

const costQuerySchema = z.object({
  convertTo: z.string().trim().toUpperCase().length(3).optional(),
  rateSource: z.enum(["RBZ_OFFICIAL", "MARKET", "MANUAL"]).optional(),
  // Optional explicit "use the rate in force on this date" (YYYY-MM-DD).
  asOf: z.coerce.date().optional(),
});

const toAdjLike = (rows: { currency: string; component: string; amount: unknown }[]): AdjustmentLike[] =>
  rows.map((r) => ({ currency: r.currency.trim(), component: r.component as "material" | "labour", amount: D(r.amount) }));

// Counts that decide completeness. For a frozen job they come from the
// snapshot (the ledger can no longer change: DB trigger), for an open job from
// the live ledger.
async function evidenceFor(orgId: string, jobId: string, actual: { basis: string; lines: ActualCostLine[]; snapshot: FrozenSnapshot | null }) {
  if (actual.snapshot) {
    const ev = actual.snapshot.evidence;
    const num = (k: string, fallback: number) => (typeof ev[k] === "number" ? (ev[k] as number) : fallback);
    return {
      costed: num("costedMovements", actual.lines.some((l) => l.materialCost.gt(0)) ? 1 : 0),
      uncosted: num("uncostedMovements", 0),
      labour: num("labourRecords", actual.lines.some((l) => l.labourCost !== null) ? 1 : 0),
    };
  }
  const live = await computeConsumptionEvidence(prisma, orgId, jobId);
  return { costed: live.costedMovements, uncosted: live.uncostedMovements, labour: live.labourRecords };
}

export async function getJobCost(session: AuthenticatedSession, jobId: string, query: unknown = {}) {
  assertCapability(session.role, "production_job:read");
  assertCapability(session.role, "cost:read");
  const parsed = costQuerySchema.safeParse(query);
  if (!parsed.success) throw new ValidationError("Invalid cost query", parsed.error.issues);

  const job = await findJobInScope(session, jobId, true);
  if (!job) throw new NotFoundError("Production job");
  const detail = job as unknown as {
    id: string; status: string; jobNumber: string; quotedAmount: unknown; quotedCurrency: string | null;
    costEstimate: { unpricedMaterials: unknown; computedAt: Date } | null;
    costEstimateLines: EstimateRow[];
    materialRequirements?: { materialItemId: string; expectedQty: unknown; uom: string; standardUnitCost: unknown; standardUnitCostCurrency: string | null }[];
  };

  const actual = await loadActual(session.orgId, detail);
  const adjustmentRows = actual.snapshot ? await listAdjustments(session.orgId, [detail.id]) : [];
  const adjLike = toAdjLike(adjustmentRows);
  const effective = applyAdjustments(actual.lines, adjLike);
  const unpriced = Array.isArray(detail.costEstimate?.unpricedMaterials) ? (detail.costEstimate!.unpricedMaterials as { materialItemId: string; reason: string }[]) : [];
  const ev = await evidenceFor(session.orgId, detail.id, actual);

  const completeness = assessCompleteness({
    isFinal: actual.basis === "snapshot",
    hasEstimate: detail.costEstimate !== null,
    unpricedMaterials: unpriced,
    uncostedConsumptionCount: ev.uncosted,
    costedConsumptionCount: ev.costed,
    labourRecordCount: ev.labour,
    hasLabourAdjustment: adjLike.some((a) => a.component === "labour"),
  });

  // Lines: snapshot/live actual (as before), enriched. Currencies that exist only
  // through an adjustment get an explicit empty snapshot line.
  const baseActual = [...actual.lines];
  for (const a of adjLike) if (!baseActual.some((l) => l.currency === a.currency)) baseActual.push({ currency: a.currency, materialCost: Z, labourCost: null });
  const baseLines = buildCurrencyLines(detail.costEstimateLines, baseActual);
  const lines = baseLines.map((l) => {
    const est = detail.costEstimateLines.find((e) => e.currency.trim() === l.currency);
    const eff = effective.find((e) => e.currency === l.currency);
    const adjMat = adjLike.filter((a) => a.currency === l.currency && a.component === "material");
    const adjLab = adjLike.filter((a) => a.currency === l.currency && a.component === "labour");
    const sum = (xs: AdjustmentLike[]) => xs.reduce((t, x) => t.add(x.amount), Z);
    const effMaterial = eff ? eff.materialCost : Z;
    return {
      ...l,
      variance: { ...l.variance, ...computeVariance(est ? D(est.estimatedMaterialCost) : null, effMaterial, completeness), material: l.variance.material },
      adjustments: { material: adjMat.length ? sum(adjMat).toString() : null, labour: adjLab.length ? sum(adjLab).toString() : null },
      adjusted: { material: effMaterial.toString(), labour: eff?.labourCost ? eff.labourCost.toString() : null },
    };
  });

  const revenue = actual.snapshot
    ? actual.snapshot.revenue !== null && actual.snapshot.revenueCurrency
      ? { amount: actual.snapshot.revenue, currency: actual.snapshot.revenueCurrency }
      : null
    : detail.quotedAmount !== null && detail.quotedCurrency
      ? { amount: D(detail.quotedAmount), currency: detail.quotedCurrency.trim() }
      : null;

  const result: Record<string, unknown> = {
    jobId: detail.id,
    jobNumber: detail.jobNumber,
    status: detail.status,
    // "live" = CALCULATED from current rows; "snapshot" = frozen at completion (ACTUAL).
    actualBasis: actual.basis,
    snapshottedAt: actual.snapshotAt,
    estimateComputedAt: detail.costEstimate?.computedAt ?? null,
    isMaterialEstimateComplete: unpriced.length === 0,
    unpricedMaterials: unpriced,
    // variance is only trustworthy when every material was priced.
    varianceReliable: unpriced.length === 0,
    lines,
    overhead: "unavailable",
    overheadReason: "no overhead allocation method has been approved",
    completeness,
    snapshot: {
      status: actual.snapshot ? "frozen" : "not_frozen",
      snapshottedAt: actual.snapshotAt,
      completenessAtCompletion: actual.snapshot ? actual.snapshot.completeness : null,
      evidence: actual.snapshot ? actual.snapshot.evidence : null,
    },
    adjustments: adjustmentRows.map(adjustmentToView),
    materialBreakdown: await materialBreakdown(session.orgId, detail, unpriced),
    // Profit uses the EFFECTIVE actual (snapshot + adjustments) and the completeness gate.
    profit: computeProfit(revenue, effective, { blockers: completeness.marginBlockers }),
  };

  if (parsed.data.convertTo) {
    // Conversion cites exchange-rate rows, so it needs the same right as reading them.
    assertCapability(session.role, "exchange_rate:read");
    result.conversion = await convert(session, parsed.data.convertTo, parsed.data.rateSource, parsed.data.asOf, actual.snapshotAt, lines, estimateByCurrency(detail.costEstimateLines));
  }
  return result;
}

const estimateByCurrency = (rows: EstimateRow[]) => new Map(rows.map((r) => [r.currency.trim(), D(r.estimatedMaterialCost)]));

// Per-material explanation of where material cost differs from the estimate.
async function materialBreakdown(
  orgId: string,
  detail: { id: string; materialRequirements?: { materialItemId: string; expectedQty: unknown; uom: string; standardUnitCost: unknown; standardUnitCostCurrency: string | null }[] },
  unpriced: { materialItemId: string; reason: string }[],
) {
  const rows = await computeActualMaterialByItem(prisma, orgId, detail.id);
  const reqs = detail.materialRequirements ?? [];
  const out = reqs.map((r) => {
    const mine = rows.filter((x) => x.itemId === r.materialItemId);
    const issuedQty = mine.reduce((t, x) => t.add(x.quantity), Z);
    const explanation = explainMaterialVariance({
      expectedQty: D(r.expectedQty),
      issuedQty,
      actualCostByCurrency: mine.map((x) => ({ currency: x.currency, cost: x.cost })),
      standardUnitCost: r.standardUnitCost === null || r.standardUnitCost === undefined ? null : D(r.standardUnitCost),
      standardCurrency: r.standardUnitCostCurrency ? r.standardUnitCostCurrency.trim() : null,
      uomMatchesStock: !unpriced.some((u) => u.materialItemId === r.materialItemId && u.reason === "uom_mismatch"),
    });
    return {
      materialItemId: r.materialItemId,
      uom: r.uom,
      expectedQty: D(r.expectedQty).toString(),
      issuedQty: issuedQty.toString(),
      overIssuedQty: Prisma.Decimal.max(issuedQty.sub(D(r.expectedQty)), 0).toString(),
      actualCost: mine.map((x) => ({ currency: x.currency, cost: x.cost.toString() })),
      explanation,
    };
  });
  return out;
}

async function convert(
  session: AuthenticatedSession,
  to: string,
  source: RateSourceValue | undefined,
  explicitAsOf: Date | undefined,
  snapshotAt: Date | null,
  lines: (CurrencyCostLine & { adjusted: { material: string; labour: string | null } })[],
  estimates: Map<string, Prisma.Decimal>,
) {
  const target = await prisma.currency.findUnique({ where: { code: to } });
  if (!target) throw new ValidationError(`Unknown currency code "${to}"`);

  // Which rate is chosen is a RULE, not "whatever is newest today":
  //  - a completed job uses the rate in force at completion AND already on
  //    record at that moment, so recording new (even back-dated) rates later
  //    cannot change a historical result;
  //  - an open job uses the latest recorded rate (it is not final anyway);
  //  - an explicit asOf date uses the rate in force on that date.
  const basis: "as_of_date" | "as_of_completion" | "latest" = explicitAsOf ? "as_of_date" : snapshotAt ? "as_of_completion" : "latest";

  const groups = [];
  let estMaterial = Z, actMaterial = Z, actLabour = Z;
  let estAll = true, labourAny = false, complete = true;

  for (const l of lines) {
    let rate: { id: string; rate: string; asOfDate: Date; source: string; recordedAt: Date } | null = null;
    let factor = new Prisma.Decimal(1);
    if (l.currency !== to) {
      const row =
        basis === "latest"
          ? await findLatestRate(session.orgId, { baseCurrency: l.currency, quoteCurrency: to, source })
          : await findRateAsOf(session.orgId, {
              baseCurrency: l.currency,
              quoteCurrency: to,
              source,
              asOf: explicitAsOf ?? snapshotAt ?? undefined,
              recordedAtOrBefore: explicitAsOf ? undefined : (snapshotAt ?? undefined),
            });
      if (row) {
        rate = { id: row.id, rate: row.rate.toString(), asOfDate: row.asOfDate, source: row.source, recordedAt: row.recordedAt };
        factor = D(row.rate);
      } else {
        complete = false;
      }
    }
    groups.push({ currency: l.currency, rate, converted: l.currency === to || rate !== null });
    if (l.currency === to || rate) {
      const est = estimates.get(l.currency);
      if (est !== undefined) estMaterial = estMaterial.add(est.mul(factor));
      else estAll = false;
      actMaterial = actMaterial.add(D(l.adjusted.material).mul(factor));
      if (l.adjusted.labour !== null) { actLabour = actLabour.add(D(l.adjusted.labour).mul(factor)); labourAny = true; }
    }
  }

  return {
    to,
    basis,
    asOf: explicitAsOf ?? snapshotAt ?? null,
    // If ANY currency has no recorded rate, no blended total is offered.
    available: complete,
    groups,
    totals: complete
      ? {
          currency: to,
          estimatedMaterial: estAll ? estMaterial.toDecimalPlaces(4).toString() : null,
          actualMaterial: actMaterial.toDecimalPlaces(4).toString(),
          actualLabour: labourAny ? actLabour.toDecimalPlaces(4).toString() : null,
        }
      : null,
  };
}

// ----------------------------------------------------------------------------
// Batch summary for the job list (UX spec §3.5): estimate + actual per job.
// ----------------------------------------------------------------------------
const summaryFilterSchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.enum(["planned", "released", "in_progress", "on_hold", "completed", "closed", "cancelled"]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export async function listJobCosts(session: AuthenticatedSession, filter: unknown = {}) {
  assertCapability(session.role, "production_job:read");
  assertCapability(session.role, "cost:read");
  const parsed = summaryFilterSchema.safeParse(filter);
  if (!parsed.success) throw new ValidationError("Invalid filter", parsed.error.issues);

  if (parsed.data.branchId) assertBranchAccess(session, parsed.data.branchId);
  const jobs = await prisma.productionJob.findMany({
    where: {
      orgId: session.orgId,
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.branchId
        ? { branchId: parsed.data.branchId }
        : session.role === "OWNER_ADMIN"
          ? {}
          : { branchId: { in: [...session.branchIds] } }),
    },
    include: { costEstimateLines: true, costEstimate: true },
    orderBy: [{ createdAt: "desc" }],
    take: parsed.data.limit ?? 200,
  });

  const frozen = jobs.filter((j) => j.status === "completed" || j.status === "closed");
  const open = jobs.filter((j) => !(j.status === "completed" || j.status === "closed"));
  const snapshotLines = frozen.length
    ? await prisma.jobCostActualLine.findMany({ where: { orgId: session.orgId, jobId: { in: frozen.map((j) => j.id) } } })
    : [];
  const snapshotIds = new Set(
    (frozen.length ? await prisma.jobCostActual.findMany({ where: { orgId: session.orgId, jobId: { in: frozen.map((j) => j.id) } }, select: { jobId: true } }) : []).map((s) => s.jobId),
  );
  // Completed jobs without a snapshot (completed before snapshots existed) fall back to live.
  const liveIds = [...open.map((j) => j.id), ...frozen.filter((j) => !snapshotIds.has(j.id)).map((j) => j.id)];
  const live = await computeActualCostLines(prisma, session.orgId, liveIds);

  return jobs.map((j) => {
    const isSnap = snapshotIds.has(j.id);
    const actual: ActualCostLine[] = isSnap
      ? snapshotLines
          .filter((l) => l.jobId === j.id)
          .map((l) => ({ currency: l.currency.trim(), materialCost: D(l.actualMaterialCost), labourCost: l.actualLabourCost === null ? null : D(l.actualLabourCost) }))
      : live.get(j.id) ?? [];
    const unpriced = Array.isArray(j.costEstimate?.unpricedMaterials) ? (j.costEstimate!.unpricedMaterials as unknown[]) : [];
    return {
      jobId: j.id,
      jobNumber: j.jobNumber,
      status: j.status,
      branchId: j.branchId,
      actualBasis: isSnap ? "snapshot" : "live",
      isMaterialEstimateComplete: unpriced.length === 0,
      lines: buildCurrencyLines(j.costEstimateLines, actual),
    };
  });
}

// ----------------------------------------------------------------------------
// Profitability report: completed jobs only, from frozen snapshots.
// ----------------------------------------------------------------------------
const reportSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  branchId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  productItemId: z.string().uuid().optional(),
});

export async function getProfitabilityReport(session: AuthenticatedSession, input: unknown = {}) {
  assertCapability(session.role, "production_job:read");
  assertCapability(session.role, "cost:read");
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid report filter", parsed.error.issues);
  const f = parsed.data;
  if (f.branchId) assertBranchAccess(session, f.branchId);

  const showCustomer = hasCapability(session.role, "customer:read");
  const jobs = await prisma.productionJob.findMany({
    where: {
      orgId: session.orgId,
      status: { in: ["completed", "closed"] },
      costActual: { isNot: null },
      ...(f.from || f.to ? { actualEnd: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
      ...(f.customerId ? { customerId: f.customerId } : {}),
      ...(f.productItemId ? { productItemId: f.productItemId } : {}),
      ...(f.branchId
        ? { branchId: f.branchId }
        : session.role === "OWNER_ADMIN"
          ? {}
          : { branchId: { in: [...session.branchIds] } }),
    },
    include: { costActual: true, costActualLines: true, costEstimate: true, customer: true, productItem: true },
    orderBy: [{ actualEnd: "desc" }],
    take: 500,
  });

  const adjustments = await listAdjustments(session.orgId, jobs.map((j) => j.id));

  const rows = jobs.map((j) => {
    const snapshotActual: ActualCostLine[] = j.costActualLines.map((l) => ({
      currency: l.currency.trim(),
      materialCost: D(l.actualMaterialCost),
      labourCost: l.actualLabourCost === null ? null : D(l.actualLabourCost),
    }));
    // Corrections to a frozen job count: effective actual = snapshot + adjustments.
    const adj = toAdjLike(adjustments.filter((a) => a.jobId === j.id));
    const actual = applyAdjustments(snapshotActual, adj);
    const ev = (j.costActual?.evidence ?? {}) as Record<string, unknown>;
    const num = (k: string, fallback: number) => (typeof ev[k] === "number" ? (ev[k] as number) : fallback);
    const unpriced = Array.isArray(j.costEstimate?.unpricedMaterials) ? (j.costEstimate!.unpricedMaterials as { materialItemId: string; reason: string }[]) : [];
    const completeness: Completeness = assessCompleteness({
      isFinal: true,
      hasEstimate: j.costEstimate !== null,
      unpricedMaterials: unpriced,
      uncostedConsumptionCount: num("uncostedMovements", 0),
      costedConsumptionCount: num("costedMovements", snapshotActual.some((l) => l.materialCost.gt(0)) ? 1 : 0),
      labourRecordCount: num("labourRecords", snapshotActual.some((l) => l.labourCost !== null) ? 1 : 0),
      hasLabourAdjustment: adj.some((a) => a.component === "labour"),
    });
    const rev = j.costActual && j.costActual.revenue !== null && j.costActual.revenueCurrency
      ? { amount: D(j.costActual.revenue), currency: j.costActual.revenueCurrency.trim() }
      : null;
    return {
      jobId: j.id,
      jobNumber: j.jobNumber,
      completedAt: j.actualEnd,
      product: { id: j.productItemId, sku: j.productItem.sku, name: j.productItem.name },
      ...(showCustomer ? { customer: j.customer ? { id: j.customer.id, name: j.customer.name } : null } : {}),
      actualCost: actual.map((a) => ({ currency: a.currency, material: a.materialCost.toString(), labour: a.labourCost?.toString() ?? null })),
      adjusted: adj.length > 0,
      missing: completeness.missing.filter((m) => m.component !== "overhead").map((m) => m.code),
      profit: computeProfit(rev, actual, { blockers: completeness.marginBlockers }),
    };
  });

  // Period totals, grouped by currency -- only jobs whose profit is computable.
  const totals = new Map<string, { revenue: Prisma.Decimal; cost: Prisma.Decimal; profit: Prisma.Decimal; jobs: number }>();
  let excluded = 0;
  for (const r of rows) {
    const p = r.profit;
    if (!p.available) { excluded += 1; continue; }
    const t = totals.get(p.currency) ?? { revenue: Z, cost: Z, profit: Z, jobs: 0 };
    t.revenue = t.revenue.add(D(p.revenue));
    t.cost = t.cost.add(D(p.actualCost));
    t.profit = t.profit.add(D(p.grossProfit));
    t.jobs += 1;
    totals.set(p.currency, t);
  }

  return {
    rows,
    totalsByCurrency: [...totals.entries()].map(([currency, t]) => ({
      currency,
      jobs: t.jobs,
      revenue: t.revenue.toString(),
      actualCost: t.cost.toString(),
      grossProfit: t.profit.toString(),
      marginPercent: t.revenue.isZero() ? null : t.profit.div(t.revenue).mul(100).toDecimalPlaces(1).toString(),
    })),
    // Jobs left out of the totals (no quote, or cost in a different currency than the quote).
    excludedJobs: excluded,
    excludesOverhead: true,
  };
}
