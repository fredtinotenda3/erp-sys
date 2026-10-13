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
import { computeActualCostLines, type ActualCostLine } from "./actual-cost";
import { findLatestRate, type RateSourceValue } from "./exchange-rate-service";

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

// Gross profit exists only when ALL actual cost is in the revenue's currency.
export function computeProfit(
  revenue: { amount: Prisma.Decimal; currency: string } | null,
  actual: ActualCostLine[],
) {
  if (!revenue) return { available: false as const, reason: "no_revenue" as const };
  if (actual.length === 0) {
    return profit(revenue, Z, false);
  }
  if (actual.some((a) => a.currency !== revenue.currency)) {
    return { available: false as const, reason: "mixed_currencies" as const };
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
    actualCost: cost.toString(),
    grossProfit: gross.toString(),
    marginPercent: revenue.amount.isZero() ? null : gross.div(revenue.amount).mul(100).toDecimalPlaces(1).toString(),
    // Both always true today; stated so the UI never presents this as full cost.
    excludesOverhead: true as const,
    labourRecorded,
  };
}

async function loadActual(orgId: string, job: { id: string; status: string }): Promise<{ basis: "snapshot" | "live"; lines: ActualCostLine[]; snapshotAt: Date | null }> {
  if (job.status === "completed" || job.status === "closed") {
    const snap = await prisma.jobCostActual.findUnique({ where: { jobId: job.id } });
    if (snap) {
      const rows = await prisma.jobCostActualLine.findMany({ where: { orgId, jobId: job.id }, orderBy: { currency: "asc" } });
      return {
        basis: "snapshot",
        snapshotAt: snap.snapshottedAt,
        lines: rows.map((r) => ({
          currency: r.currency.trim(),
          materialCost: D(r.actualMaterialCost),
          labourCost: r.actualLabourCost === null ? null : D(r.actualLabourCost),
        })),
      };
    }
  }
  const live = await computeActualCostLines(prisma, orgId, [job.id]);
  return { basis: "live", snapshotAt: null, lines: live.get(job.id) ?? [] };
}

const costQuerySchema = z.object({
  convertTo: z.string().trim().toUpperCase().length(3).optional(),
  rateSource: z.enum(["RBZ_OFFICIAL", "MARKET", "MANUAL"]).optional(),
});

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
  };

  const actual = await loadActual(session.orgId, detail);
  const lines = buildCurrencyLines(detail.costEstimateLines, actual.lines);
  const unpriced = Array.isArray(detail.costEstimate?.unpricedMaterials) ? (detail.costEstimate!.unpricedMaterials as unknown[]) : [];

  const revenue =
    detail.quotedAmount !== null && detail.quotedCurrency
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
    profit: computeProfit(revenue, actual.lines),
  };

  if (parsed.data.convertTo) {
    // Conversion cites exchange-rate rows, so it needs the same right as reading them.
    assertCapability(session.role, "exchange_rate:read");
    result.conversion = await convert(session, parsed.data.convertTo, parsed.data.rateSource, lines);
  }
  return result;
}

async function convert(
  session: AuthenticatedSession,
  to: string,
  source: RateSourceValue | undefined,
  lines: CurrencyCostLine[],
) {
  const target = await prisma.currency.findUnique({ where: { code: to } });
  if (!target) throw new ValidationError(`Unknown currency code "${to}"`);

  const groups = [];
  let estMaterial = Z, actMaterial = Z, actLabour = Z;
  let estAll = true, labourAny = false, complete = true;

  for (const l of lines) {
    let rate: { id: string; rate: string; asOfDate: Date; source: string } | null = null;
    let factor = new Prisma.Decimal(1);
    if (l.currency !== to) {
      const row = await findLatestRate(session.orgId, { baseCurrency: l.currency, quoteCurrency: to, source });
      if (row) {
        rate = { id: row.id, rate: row.rate.toString(), asOfDate: row.asOfDate, source: row.source };
        factor = D(row.rate);
      } else {
        complete = false;
      }
    }
    groups.push({ currency: l.currency, rate, converted: l.currency === to || rate !== null });
    if (l.currency === to || rate) {
      if (l.estimated.material !== null) estMaterial = estMaterial.add(D(l.estimated.material).mul(factor));
      else estAll = false;
      actMaterial = actMaterial.add(D(l.actual.material).mul(factor));
      if (l.actual.labour !== null) { actLabour = actLabour.add(D(l.actual.labour).mul(factor)); labourAny = true; }
    }
  }

  return {
    to,
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
    include: { costActual: true, costActualLines: true, customer: true, productItem: true },
    orderBy: [{ actualEnd: "desc" }],
    take: 500,
  });

  const rows = jobs.map((j) => {
    const actual: ActualCostLine[] = j.costActualLines.map((l) => ({
      currency: l.currency.trim(),
      materialCost: D(l.actualMaterialCost),
      labourCost: l.actualLabourCost === null ? null : D(l.actualLabourCost),
    }));
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
      profit: computeProfit(rev, actual),
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
