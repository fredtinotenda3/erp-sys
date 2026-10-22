// Production output: good / scrap / rework quantities, append-only.
//
// Rules (all enforced here under a per-job lock, and the row-level ones again by
// CHECK constraints):
//  - quantities are non-negative, at most 4 decimals, and at least one is > 0;
//  - the unit of measure is the PRODUCT's own (an explicit unit that differs is rejected);
//  - scrap or rework needs a reason; rework_good <= good, rework_scrap <= scrap;
//  - units can't come back from rework that were never sent to rework, and
//    (via quality dispositions) can't be reclassified more than were good;
//  - once a job has stages, output is recorded against an in-progress,
//    unblocked stage; nothing can be recorded unless the job is open for work.
// A mistaken entry is reversed with a reasoned void (production_job:update), never edited.
//
// Cost: recording output posts NO cost. The cost of scrapped or reworked units is
// already inside the job's issued material and recorded labour (Phase 2); this
// module adds quantities, not money, so nothing is counted twice.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { acceptsWork, type JobStatus } from "./job-state";
import { findJobInScope } from "./job-service";
import { checkInvariants, jobTotals, totalsByStage } from "./shopfloor-math";
import { loadShopfloor, lockShopfloor, startJobIfReleased } from "./shopfloor-data";

const D = (v: unknown) => new Prisma.Decimal(String(v));
export const REJECT_REASONS = ["wrong_dimensions", "damaged", "paint_defect", "missing_component", "other"] as const;

const qty = z
  .number()
  .finite()
  .min(0, "can't be negative")
  .max(1_000_000_000, "is too large")
  .refine((n) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6, "supports at most 4 decimal places");

const recordSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    jobStageId: z.string().uuid().optional(),
    goodQty: qty.default(0),
    scrapQty: qty.default(0),
    reworkQty: qty.default(0),
    reworkGoodQty: qty.default(0),
    reworkScrapQty: qty.default(0),
    uom: z.string().trim().min(1).max(20).optional(),
    reason: z.enum(REJECT_REASONS).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.goodQty + v.scrapQty + v.reworkQty <= 0) ctx.addIssue({ code: "custom", message: "Record at least one good, scrap or rework unit", path: ["goodQty"] });
    if ((v.scrapQty > 0 || v.reworkQty > 0) && !v.reason) ctx.addIssue({ code: "custom", message: "A reason is required for scrap or rework", path: ["reason"] });
    if (v.reworkGoodQty > v.goodQty) ctx.addIssue({ code: "custom", message: "Units back from rework can't exceed good units in this entry", path: ["reworkGoodQty"] });
    if (v.reworkScrapQty > v.scrapQty) ctx.addIssue({ code: "custom", message: "Reworked units scrapped can't exceed scrap units in this entry", path: ["reworkScrapQty"] });
  });

const voidSchema = z.object({ reason: z.string().trim().min(5, "Explain why in at least 5 characters").max(500) });

type OutputRecord = Awaited<ReturnType<typeof prisma.productionOutput.findFirstOrThrow>>;

export function toOutputView(o: OutputRecord & { void?: { reason: string; voidedBy: string | null; voidedAt: Date } | null }) {
  return {
    id: o.id,
    jobStageId: o.jobStageId,
    goodQty: String(o.goodQty),
    scrapQty: String(o.scrapQty),
    reworkQty: String(o.reworkQty),
    reworkGoodQty: String(o.reworkGoodQty),
    reworkScrapQty: String(o.reworkScrapQty),
    reclassifiedFromGoodQty: String(o.reclassifiedFromGoodQty),
    uom: o.uom,
    reason: o.reason,
    notes: o.notes,
    source: o.source as "operator" | "quality_disposition",
    inspectionId: o.inspectionId,
    operatorUserId: o.operatorUserId,
    recordedAt: o.recordedAt,
    voided: o.void ? { reason: o.void.reason, voidedBy: o.void.voidedBy, voidedAt: o.void.voidedAt } : null,
  };
}

export async function listOutput(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const rows = await prisma.productionOutput.findMany({ where: { orgId: session.orgId, jobId }, include: { void: true }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }] });
  const s = await loadShopfloor(prisma, session.orgId, jobId);
  const planned = D(job.plannedQty);
  const totals = jobTotals(s.stages, s.outputs);
  return {
    jobId,
    uom: (await prisma.item.findFirst({ where: { id: job.productItemId, orgId: session.orgId }, select: { uom: true } }))?.uom ?? null,
    entries: rows.map(toOutputView),
    totals,
    byStage: Object.fromEntries([...totalsByStage(s.outputs)].map(([k, v]) => [k ?? "none", v])),
    plannedQty: planned.toString(),
    // Informational, not a block: some over-run is normal (remakes for scrap).
    exceedsPlan: D(totals.effectiveGood).gt(planned),
  };
}

export async function recordOutput(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "output:record");
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid production output", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const product = await prisma.item.findFirst({ where: { id: job.productItemId, orgId: session.orgId }, select: { uom: true } });
  if (!product) throw new NotFoundError("Product");
  if (d.uom && d.uom !== product.uom) throw new ValidationError(`Output for this job is recorded in ${product.uom}, not ${d.uom}`);

  const existing = await prisma.productionOutput.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (existing) {
    const same =
      existing.jobId === job.id &&
      (existing.jobStageId ?? null) === (d.jobStageId ?? null) &&
      D(existing.goodQty).eq(D(d.goodQty)) &&
      D(existing.scrapQty).eq(D(d.scrapQty)) &&
      D(existing.reworkQty).eq(D(d.reworkQty)) &&
      D(existing.reworkGoodQty).eq(D(d.reworkGoodQty)) &&
      D(existing.reworkScrapQty).eq(D(d.reworkScrapQty)) &&
      (existing.reason ?? null) === (d.reason ?? null);
    if (!same) throw new ConflictError("This clientRequestId was already used for different production output");
    return { replayed: true, entry: toOutputView(existing) };
  }

  const row = await prisma.$transaction(async (tx) => {
    await lockShopfloor(tx, job.id);
    const cur = await tx.productionJob.findFirst({ where: { id: job.id, orgId: session.orgId }, select: { status: true, branchId: true, id: true } });
    if (!cur) throw new NotFoundError("Production job");
    if (!acceptsWork(cur.status as JobStatus)) throw new ConflictError(`Job is "${cur.status.replace(/_/g, " ")}" and does not accept production output`);

    const s = await loadShopfloor(tx, session.orgId, job.id);
    if (s.stages.length > 0) {
      if (!d.jobStageId) throw new ValidationError("This job has stages: choose the stage the output belongs to", [{ code: "custom", message: "Required", path: ["jobStageId"] }]);
      const st = s.stages.find((x) => x.id === d.jobStageId);
      if (!st) throw new NotFoundError("Stage");
      if (st.status !== "in_progress") throw new ConflictError(`Stage "${st.name}" is ${st.status === "pending" ? "not started" : "already completed"}; output can only be recorded against a stage in progress`);
      if (st.blocked) throw new ConflictError(`Stage "${st.name}" is blocked`);
    } else if (d.jobStageId) {
      throw new ValidationError("This job has no stages");
    }

    const candidate = {
      id: "new",
      jobStageId: d.jobStageId ?? null,
      goodQty: D(d.goodQty),
      scrapQty: D(d.scrapQty),
      reworkQty: D(d.reworkQty),
      reworkGoodQty: D(d.reworkGoodQty),
      reworkScrapQty: D(d.reworkScrapQty),
      reclassifiedFromGoodQty: D(0),
    };
    const problems = checkInvariants([...s.outputs, candidate], s.inspections, s.stages);
    if (problems.length) throw new ValidationError(problems.join(" "));

    await startJobIfReleased(tx, session, cur, "first production output");
    let created;
    try {
      created = await tx.productionOutput.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          jobStageId: d.jobStageId ?? null,
          goodQty: candidate.goodQty,
          scrapQty: candidate.scrapQty,
          reworkQty: candidate.reworkQty,
          reworkGoodQty: candidate.reworkGoodQty,
          reworkScrapQty: candidate.reworkScrapQty,
          uom: product.uom,
          reason: d.reason ?? null,
          notes: d.notes ?? null,
          operatorUserId: session.userId,
          clientRequestId: d.clientRequestId,
        },
      });
    } catch (err) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "P2002") return null;
      throw err;
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: job.branchId,
      actorUserId: session.userId,
      entityType: "production_output",
      entityId: created.id,
      action: "create",
      afterValue: { jobId: job.id, stageId: d.jobStageId ?? null, good: d.goodQty, scrap: d.scrapQty, rework: d.reworkQty, uom: product.uom },
      reason: d.reason ?? undefined,
    });
    return created;
  });

  if (!row) {
    const winner = await prisma.productionOutput.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
    if (!winner) throw new ConflictError("The output could not be recorded; retry");
    return { replayed: true, entry: toOutputView(winner) };
  }
  return { replayed: false, entry: toOutputView(row) };
}

export async function voidOutput(session: AuthenticatedSession, jobId: string, outputId: string, input: unknown) {
  assertCapability(session.role, "production_job:update");
  const parsed = voidSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid void request", parsed.error.issues);

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  return prisma.$transaction(async (tx) => {
    await lockShopfloor(tx, job.id);
    const cur = await tx.productionJob.findFirst({ where: { id: job.id, orgId: session.orgId }, select: { status: true } });
    if (!cur || !acceptsWork(cur.status as JobStatus)) throw new ConflictError("Output can only be voided while the job is open for work");

    const entry = await tx.productionOutput.findFirst({ where: { id: outputId, orgId: session.orgId, jobId: job.id }, include: { void: true } });
    if (!entry) throw new NotFoundError("Output entry");
    if (entry.void) throw new ConflictError("This entry has already been voided");
    if (entry.source !== "operator") throw new ConflictError("Entries created by a quality disposition can't be voided here");
    if (entry.jobStageId) {
      const st = await tx.productionJobStage.findFirst({ where: { id: entry.jobStageId, orgId: session.orgId } });
      if (st?.status === "completed") throw new ConflictError("This entry belongs to a completed stage and can no longer be voided");
    }

    const s = await loadShopfloor(tx, session.orgId, job.id);
    const remaining = s.outputs.filter((o) => o.id !== entry.id);
    const problems = checkInvariants(remaining, s.inspections, s.stages);
    if (problems.length) throw new ValidationError(`Voiding this entry would leave the records inconsistent. ${problems.join(" ")}`);

    const v = await tx.productionOutputVoid.create({ data: { orgId: session.orgId, jobId: job.id, outputId: entry.id, reason: parsed.data.reason, voidedBy: session.userId } });
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: job.branchId,
      actorUserId: session.userId,
      entityType: "production_output",
      entityId: entry.id,
      action: "update",
      beforeValue: { voided: false },
      afterValue: { voided: true },
      reason: parsed.data.reason,
    });
    return { voided: true, outputId: entry.id, voidId: v.id };
  });
}
