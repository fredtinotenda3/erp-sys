// Explicit corrections to a FROZEN job cost (Phase 2 §3).
//
// A completed job cannot be reopened and its snapshot can never be edited. If
// the frozen figures turn out to be wrong or incomplete (a missed labour sheet,
// a mis-priced issue) Finance records an adjustment: a signed, reasoned,
// append-only row in one currency and one component. Effective actual cost =
// snapshot + adjustments; the snapshot and every adjustment stay visible, so
// the correction is auditable rather than silent.
//
// Authorization: `cost:adjust` (Owner/Admin and Finance only) plus access to
// the job's branch. Operators and production managers cannot alter financials.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "../production/job-service";

const D = (v: unknown) => new Prisma.Decimal(String(v));

const schema = z.object({
  clientRequestId: z.string().uuid(),
  currency: z.string().trim().toUpperCase().length(3),
  component: z.enum(["material", "labour"]),
  amount: z
    .number()
    .finite()
    .refine((n) => n !== 0, "amount cannot be zero")
    .refine((n) => Math.abs(n) <= 9_999_999_999, "amount is too large")
    .refine((n) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6, "amount supports at most 4 decimal places"),
  reason: z.string().trim().min(10, "Explain the correction in at least 10 characters").max(500),
});

export interface AdjustmentView {
  id: string;
  currency: string;
  component: "material" | "labour";
  amount: string;
  reason: string;
  createdById: string | null;
  createdAt: Date;
}

const toView = (r: { id: string; currency: string; component: string; amount: unknown; reason: string; createdById: string | null; createdAt: Date }): AdjustmentView => ({
  id: r.id,
  currency: r.currency.trim(),
  component: r.component as "material" | "labour",
  amount: String(r.amount),
  reason: r.reason,
  createdById: r.createdById,
  createdAt: r.createdAt,
});

export async function listAdjustments(orgId: string, jobIds: string[]) {
  if (jobIds.length === 0) return [];
  return prisma.jobCostAdjustment.findMany({
    where: { orgId, jobId: { in: jobIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function recordCostAdjustment(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "cost:adjust");
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid cost adjustment", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const existing = await prisma.jobCostAdjustment.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (existing) {
    const same =
      existing.jobId === job.id &&
      existing.currency.trim() === d.currency &&
      existing.component === d.component &&
      D(existing.amount).eq(D(d.amount)) &&
      existing.reason === d.reason;
    if (!same) throw new ConflictError("This clientRequestId was already used for a different cost adjustment");
    return { replayed: true, adjustment: toView(existing) };
  }

  if (job.status !== "completed" && job.status !== "closed") {
    throw new ConflictError("Cost adjustments correct a frozen job cost; this job is not completed yet. Record the issue or labour itself instead.");
  }
  const currency = await prisma.currency.findUnique({ where: { code: d.currency } });
  if (!currency) throw new ValidationError(`Unknown currency code "${d.currency}"`);

  const row = await prisma.$transaction(async (tx) => {
    // Serialise adjustments on one job so the non-negative check below is exact.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${job.id}, 11))`;

    const snapshotLine = await tx.jobCostActualLine.findUnique({ where: { jobId_currency: { jobId: job.id, currency: d.currency } } });
    const prior = await tx.jobCostAdjustment.findMany({ where: { orgId: session.orgId, jobId: job.id, currency: d.currency, component: d.component } });
    const base = d.component === "material" ? D(snapshotLine?.actualMaterialCost ?? 0) : D(snapshotLine?.actualLabourCost ?? 0);
    const effective = prior.reduce((sum, p) => sum.add(D(p.amount)), base).add(D(d.amount));
    if (effective.isNegative()) {
      throw new ValidationError(`That would make ${d.currency} ${d.component} cost negative (${effective.toString()}). Adjust by a smaller amount.`);
    }

    let created;
    try {
      created = await tx.jobCostAdjustment.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          currency: d.currency,
          component: d.component,
          amount: D(d.amount),
          reason: d.reason,
          clientRequestId: d.clientRequestId,
          createdById: session.userId,
        },
      });
    } catch (err) {
      // Same-id race: the unique index decided; surface the winner as a replay.
      if (typeof err === "object" && err && (err as { code?: string }).code === "P2002") return null;
      throw err;
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: job.branchId,
      actorUserId: session.userId,
      entityType: "job_cost_adjustment",
      entityId: created.id,
      action: "create",
      afterValue: { jobId: job.id, currency: d.currency, component: d.component, amount: String(d.amount) },
      reason: d.reason,
    });
    return created;
  });

  if (!row) {
    const winner = await prisma.jobCostAdjustment.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
    if (!winner) throw new ConflictError("The adjustment could not be recorded; retry");
    return { replayed: true, adjustment: toView(winner) };
  }
  return { replayed: false, adjustment: toView(row) };
}

export { toView as adjustmentToView };
