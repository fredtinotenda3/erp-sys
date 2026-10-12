// Issuing materials to a production job, and the per-job expected-vs-issued
// view (the data behind the job's "Materials" tab).
//
// An issue to a job is stored as movement_type = production_consumption with
// reference_type = production_job. That exact pairing is what the job-cost
// views (job_material_cost_live) and the shortage calculation read, so it must
// not drift. Generic non-job issues (material_issue) are not exposed here.
//
// Over-issue (more than the BOM expects) is ALLOWED: over-consumption is
// precisely the variance the product exists to surface. What cannot happen is
// the stock going negative, which the ledger trigger refuses.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "../production/job-service";
import { acceptsWork, type JobStatus } from "../production/job-state";
import { findWarehouseInScope } from "./warehouse-service";
import { checkReplay, findByClientRequestId, postMovement, readBalance, toMovementView } from "./stock-core";

const issueSchema = z.object({
  clientRequestId: z.string().uuid(),
  materialItemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z
    .number()
    .finite()
    .positive()
    .max(1_000_000_000)
    .refine((n) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6, "quantity supports at most 4 decimal places"),
  occurredAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, "occurredAt cannot be in the future")
    .optional(),
});

export async function issueMaterialToJob(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "material:issue");
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid material issue payload", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");

  const args = {
    warehouse: { id: warehouse.id, branchId: warehouse.branchId },
    itemId: d.materialItemId,
    movementType: "production_consumption" as const,
    quantity: new Prisma.Decimal(d.quantity).neg(),
    unitCost: null, // stamped by the ledger trigger at the current weighted-average cost
    currency: null,
    referenceType: "production_job" as const,
    referenceId: job.id,
    reason: null,
    clientRequestId: d.clientRequestId,
    occurredAt: d.occurredAt,
  };

  // A retried offline submission must succeed even if the job has since moved on.
  const existing = await findByClientRequestId(session.orgId, d.clientRequestId);
  if (existing) {
    const r = checkReplay(existing, args);
    return shape(session, r.replayed, r.movement, d.materialItemId, warehouse.id);
  }

  if (!acceptsWork(job.status as JobStatus)) {
    throw new ConflictError(`Material cannot be issued to a job that is "${job.status}" (it must be released or in progress)`);
  }
  if (warehouse.branchId !== job.branchId) {
    throw new ValidationError("Material can only be issued from a warehouse in the same branch as the job");
  }
  if (!warehouse.isActive) throw new ValidationError("Cannot issue from an inactive warehouse");

  const requirement = await prisma.materialRequirement.findFirst({
    where: { orgId: session.orgId, jobId: job.id, materialItemId: d.materialItemId },
  });
  if (!requirement) {
    throw new ValidationError("That material is not part of this job's bill of materials");
  }

  const wasReleased = job.status === "released";
  const result = await postMovement(session, {
    ...args,
    afterInsert: async (tx) => {
      if (!wasReleased) return;
      const moved = await tx.productionJob.updateMany({
        where: { id: job.id, orgId: session.orgId, status: "released" },
        data: { status: "in_progress", actualStart: new Date() },
      });
      if (moved.count === 1) {
        await recordAudit(tx, {
          orgId: session.orgId,
          branchId: job.branchId,
          actorUserId: session.userId,
          entityType: "production_job",
          entityId: job.id,
          action: "transition",
          beforeValue: { status: "released" },
          afterValue: { status: "in_progress" },
          reason: "first material issue",
        });
      }
    },
  });
  return shape(session, result.replayed, result.movement, d.materialItemId, warehouse.id);
}

async function shape(
  session: AuthenticatedSession,
  replayed: boolean,
  movement: Parameters<typeof toMovementView>[1],
  itemId: string,
  warehouseId: string,
) {
  return {
    replayed,
    movement: toMovementView(session.role, movement),
    // Only callers who may read stock see the resulting balance.
    balance: await readBalance(session, itemId, warehouseId),
  };
}

/** Expected (BOM snapshot) vs issued (ledger) per material, for one job. */
export async function getJobMaterials(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const [requirements, issued] = await Promise.all([
    prisma.materialRequirement.findMany({ where: { orgId: session.orgId, jobId: job.id } }),
    prisma.stockMovement.groupBy({
      by: ["itemId"],
      where: { orgId: session.orgId, referenceType: "production_job", referenceId: job.id, movementType: "production_consumption" },
      _sum: { quantity: true },
    }),
  ]);
  const issuedByItem = new Map(issued.map((g) => [g.itemId, new Prisma.Decimal(g._sum.quantity ?? 0).neg()]));
  const showCost = hasCapability(session.role, "cost:read");

  return requirements.map((r) => {
    const issuedQty = issuedByItem.get(r.materialItemId) ?? new Prisma.Decimal(0);
    const expected = new Prisma.Decimal(r.expectedQty);
    return {
      materialItemId: r.materialItemId,
      uom: r.uom,
      expectedQty: expected, // PLANNED: snapshot from job creation
      issuedQty, // ACTUAL: summed from the ledger
      remainingQty: Prisma.Decimal.max(expected.sub(issuedQty), 0), // CALCULATED
      overIssuedQty: Prisma.Decimal.max(issuedQty.sub(expected), 0), // CALCULATED; >0 is a variance, not an error
      ...(showCost ? { standardUnitCost: r.standardUnitCost, standardUnitCostCurrency: r.standardUnitCostCurrency } : {}),
    };
  });
}
