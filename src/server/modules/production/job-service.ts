// Production jobs: creation (BOM snapshot + material requirements + per-
// currency cost estimate), reads, and the state machine (job-state.ts).
//
// Invariants this file is responsible for:
//  - BOM SNAPSHOT: a job stores the specific BOM version's id AND copies the
//    material quantities into its own MaterialRequirement rows at creation.
//    Later BOM edits/activations can never change an existing job.
//  - NO MIXED CURRENCIES: the cost estimate is one JobCostEstimateLine per
//    currency. A material with no standard cost (or a unit mismatch) is
//    listed as unpriced -- never guessed, never counted as 0.
//  - BRANCH SCOPE: every read/write checks the job's branch against the
//    session. A job in a branch the caller cannot access is reported as
//    "not found", not "forbidden", so its existence isn't disclosed.
//  - GAP-FREE NUMBERING: JOB-00001... from a per-org counter row incremented
//    inside the creating transaction (row-locked => concurrency-safe, and
//    rolled back with the transaction if creation fails).
//
// Completing a job freezes its actual cost: in the SAME transaction as the
// status change, the per-currency actual cost (derived from the immutable
// stock ledger and labour records) is written to job_cost_actual /
// job_cost_actual_line, which the database then refuses to ever modify.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, assertBranchAccess, hasBranchAccess, type Capability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import { computeActualCostLines } from "../costing/actual-cost";
import type { AuthenticatedSession } from "../iam/session-service";
import { canTransition, JOB_STATUS_VALUES, type JobStatus } from "./job-state";
import { toJobView, type JobRow } from "./job-view";

const MAX_DECIMAL = new Prisma.Decimal("9999999999"); // fits numeric(14,4)

const createJobSchema = z
  .object({
    branchId: z.string().uuid(),
    productItemId: z.string().uuid(),
    plannedQty: z.number().finite().positive().max(1_000_000),
    plannedStart: z.coerce.date().optional(),
    plannedEnd: z.coerce.date().optional(),
    customerId: z.string().uuid().optional(),
    quotedAmount: z.number().finite().nonnegative().max(9_999_999_999).optional(),
    quotedCurrency: z.string().trim().toUpperCase().length(3).optional(),
  })
  .superRefine((d, ctx) => {
    if ((d.quotedAmount === undefined) !== (d.quotedCurrency === undefined)) {
      ctx.addIssue({ code: "custom", message: "quotedAmount and quotedCurrency must be provided together", path: ["quotedAmount"] });
    }
    if (d.plannedStart && d.plannedEnd && d.plannedEnd < d.plannedStart) {
      ctx.addIssue({ code: "custom", message: "plannedEnd cannot be before plannedStart", path: ["plannedEnd"] });
    }
  });

const transitionSchema = z.object({
  status: z.enum(JOB_STATUS_VALUES),
  reason: z.string().trim().min(1).max(500).optional(),
});

const JOB_INCLUDE = {
  materialRequirements: true,
  costEstimate: true,
  costEstimateLines: true,
} as const;

type UnpricedReason = "no_standard_cost" | "uom_mismatch";

export async function createJob(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "production_job:create");
  const parsed = createJobSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid production job payload", parsed.error.issues);
  const data = parsed.data;

  assertBranchAccess(session, data.branchId);

  const branch = await prisma.branch.findFirst({ where: { orgId: session.orgId, id: data.branchId } });
  if (!branch) throw new ValidationError("branchId does not belong to this organization");
  if (!branch.isActive) throw new ValidationError("Cannot create a job in an inactive branch");

  const product = await prisma.item.findFirst({ where: { orgId: session.orgId, id: data.productItemId } });
  if (!product) throw new ValidationError("productItemId does not belong to this organization");
  if (!product.isActive) throw new ValidationError("Cannot create a job for an inactive item");
  if (product.itemType !== "finished_good" && product.itemType !== "wip") {
    throw new ValidationError("Only finished_good or wip items can be produced");
  }

  if (data.customerId) {
    const customer = await prisma.customer.findFirst({ where: { orgId: session.orgId, id: data.customerId } });
    if (!customer) throw new ValidationError("customerId does not belong to this organization");
    if (customer.status !== "active") throw new ValidationError("Cannot create a job for an inactive customer");
  }

  if (data.quotedCurrency) {
    const currency = await prisma.currency.findUnique({ where: { code: data.quotedCurrency } });
    if (!currency) throw new ValidationError(`Unknown currency code "${data.quotedCurrency}"`);
  }

  const bom = await prisma.billOfMaterial.findFirst({
    where: { orgId: session.orgId, productItemId: product.id, status: "active" },
    include: { lines: { include: { materialItem: true } } },
  });
  if (!bom) {
    throw new ValidationError("This item has no active BOM — create and activate one before creating a job");
  }

  const plannedQty = new Prisma.Decimal(data.plannedQty);

  // Pure computation, done before the transaction.
  const unpriced: { materialItemId: string; reason: UnpricedReason }[] = [];
  const totalsByCurrency = new Map<string, Prisma.Decimal>();
  const requirementRows = bom.lines.map((line) => {
    const expectedQty = new Prisma.Decimal(line.quantity).mul(plannedQty).toDecimalPlaces(4);
    if (expectedQty.gt(MAX_DECIMAL)) {
      throw new ValidationError("plannedQty is too large for this BOM (expected material quantity out of range)");
    }
    const item = line.materialItem;
    let unitCost: Prisma.Decimal | null = null;
    let unitCurrency: string | null = null;
    if (item.standardCost === null || item.standardCostCurrency === null) {
      unpriced.push({ materialItemId: item.id, reason: "no_standard_cost" });
    } else if (line.uom !== item.uom) {
      // BOM says "2 m" but the standard cost is per "kg": converting would be
      // a guess, so the line is reported as unpriced instead.
      unpriced.push({ materialItemId: item.id, reason: "uom_mismatch" });
    } else {
      unitCost = new Prisma.Decimal(item.standardCost);
      unitCurrency = item.standardCostCurrency;
      const lineTotal = expectedQty.mul(unitCost);
      totalsByCurrency.set(unitCurrency, (totalsByCurrency.get(unitCurrency) ?? new Prisma.Decimal(0)).add(lineTotal));
    }
    return {
      orgId: session.orgId,
      materialItemId: line.materialItemId,
      expectedQty,
      uom: line.uom,
      standardUnitCost: unitCost,
      standardUnitCostCurrency: unitCurrency,
    };
  });
  for (const total of totalsByCurrency.values()) {
    if (total.toDecimalPlaces(4).gt(MAX_DECIMAL)) {
      throw new ValidationError("Estimated cost is out of range; reduce plannedQty");
    }
  }

  let jobId: string;
  try {
    jobId = await prisma.$transaction(async (tx) => {
      const counter = await tx.$queryRaw<{ last_number: number }[]>`
        INSERT INTO job_number_counter (org_id, last_number)
        VALUES (${session.orgId}::uuid, 1)
        ON CONFLICT (org_id) DO UPDATE SET last_number = job_number_counter.last_number + 1
        RETURNING last_number`;
      const jobNumber = `JOB-${String(counter[0].last_number).padStart(5, "0")}`;

      const job = await tx.productionJob.create({
        data: {
          orgId: session.orgId,
          branchId: data.branchId,
          jobNumber,
          customerId: data.customerId ?? null,
          productItemId: product.id,
          bomId: bom.id,
          plannedQty,
          plannedStart: data.plannedStart ?? null,
          plannedEnd: data.plannedEnd ?? null,
          status: "planned",
          quotedAmount: data.quotedAmount ?? null,
          quotedCurrency: data.quotedCurrency ?? null,
          createdById: session.userId,
        },
      });

      await tx.materialRequirement.createMany({
        data: requirementRows.map((r) => ({ ...r, jobId: job.id })),
      });

      await tx.jobCostEstimate.create({
        data: { orgId: session.orgId, jobId: job.id, unpricedMaterials: unpriced },
      });
      if (totalsByCurrency.size > 0) {
        await tx.jobCostEstimateLine.createMany({
          data: [...totalsByCurrency.entries()].map(([currency, total]) => ({
            orgId: session.orgId,
            jobId: job.id,
            currency,
            estimatedMaterialCost: total.toDecimalPlaces(4),
            // Labour and overhead stay null = unavailable. Never 0.
            estimatedLabourCost: null,
            estimatedOverheadCost: null,
          })),
        });
      }

      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: data.branchId,
        actorUserId: session.userId,
        entityType: "production_job",
        entityId: job.id,
        action: "create",
        afterValue: {
          jobNumber,
          productItemId: product.id,
          bomId: bom.id,
          bomVersion: bom.version,
          plannedQty: plannedQty.toString(),
          requirementCount: requirementRows.length,
          unpricedMaterialCount: unpriced.length,
        },
      });
      return job.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ConflictError("A job with this number already exists — retry the request");
    }
    throw err;
  }

  return getJob(session, jobId);
}

// Shared by labour-service. Returns null when the job does not exist in the
// caller's org OR is in a branch the caller cannot access.
export async function findJobInScope(session: AuthenticatedSession, id: string, withDetail = false) {
  const job = await prisma.productionJob.findFirst({
    where: { orgId: session.orgId, id },
    include: withDetail ? JOB_INCLUDE : undefined,
  });
  if (!job) return null;
  if (!hasBranchAccess(session, job.branchId)) return null;
  return job;
}

export async function getJob(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, id, true);
  if (!job) throw new NotFoundError("Production job");
  return toJobView(session.role, job as unknown as JobRow);
}

export interface ListJobsFilter {
  branchId?: string;
  status?: JobStatus;
  overdueOnly?: boolean;
  limit?: number;
}

export async function listJobs(session: AuthenticatedSession, filter: ListJobsFilter = {}) {
  assertCapability(session.role, "production_job:read");

  const where: Prisma.ProductionJobWhereInput = { orgId: session.orgId };
  if (filter.branchId) {
    assertBranchAccess(session, filter.branchId);
    where.branchId = filter.branchId;
  } else if (session.role !== "OWNER_ADMIN") {
    // No fallback to org-wide: a non-owner only ever sees granted branches.
    where.branchId = { in: [...session.branchIds] };
  }
  if (filter.status) where.status = filter.status;
  if (filter.overdueOnly) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    where.plannedEnd = { lt: today };
    where.status = { in: ["planned", "released", "in_progress", "on_hold"] };
  }

  const jobs = await prisma.productionJob.findMany({
    where,
    include: { costEstimate: true, costEstimateLines: true },
    orderBy: [{ plannedEnd: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: Math.min(filter.limit ?? 200, 500),
  });
  return jobs.map((j) => toJobView(session.role, j as unknown as JobRow));
}

async function applyTransition(
  session: AuthenticatedSession,
  id: string,
  target: JobStatus,
  reason: string | undefined,
) {
  const job = await findJobInScope(session, id);
  if (!job) throw new NotFoundError("Production job");

  const from = job.status as JobStatus;
  if (!canTransition(from, target, job.actualStart !== null)) {
    throw new ConflictError(`A job cannot move from "${from}" to "${target}"`);
  }
  if ((target === "cancelled" || target === "on_hold") && !reason) {
    throw new ValidationError(`A reason is required when moving a job to "${target}"`);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Compare-and-set on the status we validated against: if another request
    // moved the job in between, nothing is written.
    const result = await tx.productionJob.updateMany({
      where: { id: job.id, orgId: session.orgId, status: from },
      data: {
        status: target,
        ...(target === "in_progress" && !job.actualStart ? { actualStart: now } : {}),
        ...(target === "completed" ? { actualEnd: now } : {}),
      },
    });
    if (result.count !== 1) throw new ConflictError("The job was changed by someone else — reload and retry");

    if (target === "completed") {
      const actual = (await computeActualCostLines(tx, session.orgId, [job.id])).get(job.id) ?? [];
      await tx.jobCostActual.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          revenue: job.quotedAmount,
          revenueCurrency: job.quotedCurrency,
        },
      });
      if (actual.length > 0) {
        await tx.jobCostActualLine.createMany({
          data: actual.map((l) => ({
            orgId: session.orgId,
            jobId: job.id,
            currency: l.currency,
            actualMaterialCost: l.materialCost,
            actualLabourCost: l.labourCost,
            actualOverheadCost: null, // unavailable: no allocation method approved
          })),
        });
      }
      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: job.branchId,
        actorUserId: session.userId,
        entityType: "job_cost_actual",
        entityId: job.id,
        action: "create",
        afterValue: {
          currencies: actual.map((l) => l.currency),
          revenueCurrency: job.quotedCurrency,
        },
      });
    }

    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: job.branchId,
      actorUserId: session.userId,
      entityType: "production_job",
      entityId: job.id,
      action: "transition",
      beforeValue: { status: from },
      afterValue: { status: target },
      reason: reason ?? null,
    });
  });

  return getJob(session, job.id);
}

export async function transitionJob(session: AuthenticatedSession, id: string, input: unknown) {
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid transition payload", parsed.error.issues);
  const { status, reason } = parsed.data;

  if (status === "completed") {
    throw new ValidationError('Use the complete endpoint to move a job to "completed"');
  }
  const needed: Capability = status === "closed" ? "production_job:complete" : "production_job:update";
  assertCapability(session.role, needed);
  return applyTransition(session, id, status, reason);
}

// The highest-consequence action in the app (ARCHITECTURE.md §9): managers only.
export async function completeJob(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "production_job:complete");
  return applyTransition(session, id, "completed", undefined);
}

// ----------------------------------------------------------------------------
// Editing a job's schedule, customer and quote. The product, quantity and BOM
// snapshot are NOT editable: they define the material requirements and the
// estimate, and changing them would silently rewrite history. To change those,
// cancel the job and create a new one.
// ----------------------------------------------------------------------------
const updateJobSchema = z
  .object({
    plannedStart: z.coerce.date().nullable(),
    plannedEnd: z.coerce.date().nullable(),
    customerId: z.string().uuid().nullable(),
    quotedAmount: z.number().finite().nonnegative().max(9_999_999_999).nullable(),
    quotedCurrency: z.string().trim().toUpperCase().length(3).nullable(),
  })
  .partial()
  .strict() // product, quantity and BOM are deliberately not editable: unknown keys are rejected, not ignored
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

const EDITABLE: JobStatus[] = ["planned", "released", "in_progress", "on_hold"];

export async function updateJob(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "production_job:update");
  const parsed = updateJobSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid job update", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, id);
  if (!job) throw new NotFoundError("Production job");
  if (!EDITABLE.includes(job.status as JobStatus)) {
    throw new ConflictError(`A job that is "${job.status}" can no longer be edited`);
  }

  const plannedStart = d.plannedStart !== undefined ? d.plannedStart : job.plannedStart;
  const plannedEnd = d.plannedEnd !== undefined ? d.plannedEnd : job.plannedEnd;
  if (plannedStart && plannedEnd && plannedEnd < plannedStart) {
    throw new ValidationError("plannedEnd cannot be before plannedStart");
  }
  const quotedAmount = d.quotedAmount !== undefined ? d.quotedAmount : job.quotedAmount === null ? null : Number(job.quotedAmount);
  const quotedCurrency = d.quotedCurrency !== undefined ? d.quotedCurrency : job.quotedCurrency;
  if ((quotedAmount === null) !== (quotedCurrency === null)) {
    throw new ValidationError("quotedAmount and quotedCurrency must be set or cleared together");
  }
  if (d.quotedCurrency) {
    const c = await prisma.currency.findUnique({ where: { code: d.quotedCurrency } });
    if (!c) throw new ValidationError(`Unknown currency code "${d.quotedCurrency}"`);
  }
  if (d.customerId) {
    const customer = await prisma.customer.findFirst({ where: { orgId: session.orgId, id: d.customerId } });
    if (!customer) throw new ValidationError("customerId does not belong to this organization");
    if (customer.status !== "active") throw new ValidationError("Cannot assign an inactive customer");
  }

  const data: Prisma.ProductionJobUncheckedUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = <K extends keyof typeof d>(key: K, column: string, value: unknown, current: unknown) => {
    before[key as string] = current ?? null;
    after[key as string] = value;
    (data as Record<string, unknown>)[column] = value;
  };
  if (d.plannedStart !== undefined) set("plannedStart", "plannedStart", d.plannedStart, job.plannedStart);
  if (d.plannedEnd !== undefined) set("plannedEnd", "plannedEnd", d.plannedEnd, job.plannedEnd);
  if (d.customerId !== undefined) set("customerId", "customerId", d.customerId, job.customerId);
  if (d.quotedAmount !== undefined) set("quotedAmount", "quotedAmount", d.quotedAmount, job.quotedAmount === null ? null : String(job.quotedAmount));
  if (d.quotedCurrency !== undefined) set("quotedCurrency", "quotedCurrency", d.quotedCurrency, job.quotedCurrency);

  await prisma.$transaction(async (tx) => {
    const res = await tx.productionJob.updateMany({
      where: { id: job.id, orgId: session.orgId, status: job.status },
      data,
    });
    if (res.count !== 1) throw new ConflictError("The job was changed by someone else — reload and retry");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: job.branchId,
      actorUserId: session.userId,
      entityType: "production_job",
      entityId: job.id,
      action: "update",
      beforeValue: before,
      afterValue: after,
    });
  });
  return getJob(session, job.id);
}
