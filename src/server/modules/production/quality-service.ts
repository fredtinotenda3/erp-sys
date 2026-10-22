// Quality control: inspection results and authorised dispositions.
//
// Model
//  - An inspection RESULT (quality_record) says: N units inspected, M rejected,
//    by whom, when, why (defect category + notes). Outcome is derived and stored:
//    pass iff nothing was rejected. Results are append-only; a failed inspection
//    is never silently discarded or overwritten.
//  - "Pending" is not a stored state: a stage that requires inspection and has
//    unaccounted good units IS pending (see stage views / readiness).
//  - Rejected units must be DISPOSITIONED by someone holding quality:approve:
//      scrap      -> written off (creates a system scrap entry in the output ledger)
//      rework     -> sent for rework (creates a system rework entry; must come back
//                    through output as rework_good / rework_scrap)
//      use_as_is  -> a recorded concession; the units stay good
//    An inspector without quality:approve cannot decide what happens to rejects.
//  - Inspection can only cover units reported good for that stage and not yet inspected.
// Cost: a disposition adds quantities (and a reasoned audit trail), never money.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { acceptsWork, type JobStatus } from "./job-state";
import { findJobInScope } from "./job-service";
import { REJECT_REASONS } from "./output-service";
import { checkInvariants, totalsOf } from "./shopfloor-math";
import { loadShopfloor, lockShopfloor, startJobIfReleased } from "./shopfloor-data";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const q4 = (label: string) =>
  z
    .number()
    .finite()
    .max(1_000_000_000, `${label} is too large`)
    .refine((n) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6, `${label} supports at most 4 decimal places`);

const inspectSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    jobStageId: z.string().uuid().optional(),
    inspectedQty: q4("Inspected quantity").refine((n) => n > 0, "Inspect at least one unit"),
    rejectedQty: q4("Rejected quantity").refine((n) => n >= 0, "can't be negative").default(0),
    rejectReason: z.enum(REJECT_REASONS).optional(),
    notes: z.string().trim().max(500).optional(),
    evidenceRef: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.rejectedQty > v.inspectedQty) ctx.addIssue({ code: "custom", message: "Rejected units can't exceed inspected units", path: ["rejectedQty"] });
    if (v.rejectedQty > 0 && !v.rejectReason) ctx.addIssue({ code: "custom", message: "A defect category is required when units are rejected", path: ["rejectReason"] });
  });

const dispositionSchema = z.object({
  clientRequestId: z.string().uuid(),
  kind: z.enum(["scrap", "rework", "use_as_is"]),
  qty: q4("Quantity").refine((n) => n > 0, "must be greater than zero"),
  reason: z.string().trim().min(5, "Explain the decision in at least 5 characters").max(500),
});

type Rec = Awaited<ReturnType<typeof prisma.qualityRecord.findFirstOrThrow>> & { dispositions?: { id: string; kind: string; qty: unknown; reason: string; decidedBy: string; decidedAt: Date }[] };

export function toInspectionView(r: Rec) {
  const dispositioned = (r.dispositions ?? []).reduce((t, d) => t.add(D(d.qty)), D(0));
  const rejected = D(r.rejectedQty);
  const open = rejected.sub(dispositioned);
  return {
    id: r.id,
    jobStageId: r.jobStageId,
    inspectedQty: String(r.producedQty),
    acceptedQty: String(r.acceptedQty),
    rejectedQty: String(r.rejectedQty),
    outcome: (r.outcome ?? (rejected.isZero() ? "pass" : "fail")) as "pass" | "fail",
    defectCategory: r.rejectReason,
    notes: r.notes,
    evidenceRef: r.evidenceRef,
    uom: r.uom,
    inspectorUserId: r.inspectorUserId,
    inspectedAt: r.recordedAt,
    // pass | open (rejects still need a decision) | resolved
    disposition: rejected.isZero() ? ("not_needed" as const) : open.gt(0) ? ("open" as const) : ("resolved" as const),
    openRejectedQty: open.toString(),
    dispositions: (r.dispositions ?? []).map((d) => ({ id: d.id, kind: d.kind as "scrap" | "rework" | "use_as_is", qty: String(d.qty), reason: d.reason, decidedBy: d.decidedBy, decidedAt: d.decidedAt })),
  };
}

export async function listInspections(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "quality:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const rows = await prisma.qualityRecord.findMany({ where: { orgId: session.orgId, jobId }, include: { dispositions: { orderBy: { decidedAt: "asc" } } }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }] });
  const views = rows.map((r) => toInspectionView(r as Rec));
  const sum = (f: (v: (typeof views)[number]) => string) => views.reduce((t, v) => t.add(D(f(v))), D(0)).toString();
  return {
    jobId,
    inspections: views,
    summary: {
      total: views.length,
      passed: views.filter((v) => v.outcome === "pass").length,
      failed: views.filter((v) => v.outcome === "fail").length,
      inspectedUnits: sum((v) => v.inspectedQty),
      rejectedUnits: sum((v) => v.rejectedQty),
      openRejectedUnits: sum((v) => v.openRejectedQty),
    },
  };
}

export async function recordInspection(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "quality:record");
  const parsed = inspectSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid inspection", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const product = await prisma.item.findFirst({ where: { id: job.productItemId, orgId: session.orgId }, select: { uom: true } });
  if (!product) throw new NotFoundError("Product");

  const existing = await prisma.qualityRecord.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId }, include: { dispositions: true } });
  if (existing) {
    const same =
      existing.jobId === job.id &&
      (existing.jobStageId ?? null) === (d.jobStageId ?? null) &&
      D(existing.producedQty).eq(D(d.inspectedQty)) &&
      D(existing.rejectedQty).eq(D(d.rejectedQty)) &&
      (existing.rejectReason ?? null) === (d.rejectReason ?? null);
    if (!same) throw new ConflictError("This clientRequestId was already used for a different inspection");
    return { replayed: true, inspection: toInspectionView(existing as Rec) };
  }

  const created = await prisma.$transaction(async (tx) => {
    await lockShopfloor(tx, job.id);
    const cur = await tx.productionJob.findFirst({ where: { id: job.id, orgId: session.orgId }, select: { status: true, branchId: true, id: true } });
    if (!cur) throw new NotFoundError("Production job");
    if (!acceptsWork(cur.status as JobStatus)) throw new ConflictError(`Job is "${cur.status.replace(/_/g, " ")}" and does not accept inspections`);

    const s = await loadShopfloor(tx, session.orgId, job.id);
    if (s.stages.length > 0) {
      if (!d.jobStageId) throw new ValidationError("This job has stages: choose the stage being inspected", [{ code: "custom", message: "Required", path: ["jobStageId"] }]);
      const st = s.stages.find((x) => x.id === d.jobStageId);
      if (!st) throw new NotFoundError("Stage");
      if (st.status !== "in_progress") throw new ConflictError(`Stage "${st.name}" is ${st.status === "pending" ? "not started" : "already completed"}; it can only be inspected while in progress`);
    } else if (d.jobStageId) {
      throw new ValidationError("This job has no stages");
    }

    // Only units reported good, and not already inspected, can be inspected.
    const scope = d.jobStageId ?? null;
    const good = totalsOf(s.outputs.filter((o) => o.jobStageId === scope)).grossGood;
    const inspected = s.inspections.filter((i) => i.jobStageId === scope).reduce((t, i) => t.add(i.producedQty), D(0));
    const available = D(good).sub(inspected);
    if (D(d.inspectedQty).gt(available)) {
      throw new ValidationError(`Only ${available.toString()} reported-good unit(s) remain to inspect${scope ? " at this stage" : ""}; record the output first.`, [{ code: "custom", message: "Too many", path: ["inspectedQty"] }]);
    }

    await startJobIfReleased(tx, session, cur, "first inspection");
    let row;
    try {
      row = await tx.qualityRecord.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          jobStageId: d.jobStageId ?? null,
          producedQty: D(d.inspectedQty),
          acceptedQty: D(d.inspectedQty).sub(D(d.rejectedQty)),
          rejectedQty: D(d.rejectedQty),
          rejectReason: d.rejectedQty > 0 ? d.rejectReason! : null,
          notes: d.notes ?? null,
          evidenceRef: d.evidenceRef ?? null,
          uom: product.uom,
          inspectorUserId: session.userId,
          outcome: d.rejectedQty > 0 ? "fail" : "pass",
          clientRequestId: d.clientRequestId,
        },
        include: { dispositions: true },
      });
    } catch (err) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "P2002") return null;
      throw err;
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: job.branchId,
      actorUserId: session.userId,
      entityType: "quality_record",
      entityId: row.id,
      action: "create",
      afterValue: { jobId: job.id, stageId: d.jobStageId ?? null, outcome: row.outcome, inspected: d.inspectedQty, rejected: d.rejectedQty, defect: d.rejectReason ?? null },
      reason: d.notes ?? undefined,
    });
    return row;
  });

  if (!created) {
    const winner = await prisma.qualityRecord.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId }, include: { dispositions: true } });
    if (!winner) throw new ConflictError("The inspection could not be recorded; retry");
    return { replayed: true, inspection: toInspectionView(winner as Rec) };
  }
  return { replayed: false, inspection: toInspectionView(created as Rec) };
}

export async function recordDisposition(session: AuthenticatedSession, jobId: string, inspectionId: string, input: unknown) {
  // Deciding what happens to rejected units is an approval, not an inspection.
  assertCapability(session.role, "quality:approve");
  const parsed = dispositionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid disposition", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const prior = await prisma.qualityDisposition.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (prior) {
    const same = prior.inspectionId === inspectionId && prior.kind === d.kind && D(prior.qty).eq(D(d.qty)) && prior.reason === d.reason;
    if (!same) throw new ConflictError("This clientRequestId was already used for a different disposition");
    return { replayed: true, disposition: { id: prior.id, kind: prior.kind, qty: String(prior.qty) } };
  }

  const out = await prisma.$transaction(async (tx) => {
    await lockShopfloor(tx, job.id);
    const cur = await tx.productionJob.findFirst({ where: { id: job.id, orgId: session.orgId }, select: { status: true } });
    if (!cur || !acceptsWork(cur.status as JobStatus)) throw new ConflictError("Dispositions can only be recorded while the job is open for work");

    const rec = await tx.qualityRecord.findFirst({ where: { id: inspectionId, orgId: session.orgId, jobId: job.id }, include: { dispositions: true } });
    if (!rec) throw new NotFoundError("Inspection");
    if (D(rec.rejectedQty).isZero()) throw new ConflictError("This inspection rejected nothing, so there is nothing to dispose of");
    const open = D(rec.rejectedQty).sub(rec.dispositions.reduce((t, x) => t.add(D(x.qty)), D(0)));
    if (D(d.qty).gt(open)) throw new ValidationError(`Only ${open.toString()} rejected unit(s) are still awaiting a decision`, [{ code: "custom", message: "Too many", path: ["qty"] }]);

    let disp;
    try {
      disp = await tx.qualityDisposition.create({
        data: { orgId: session.orgId, jobId: job.id, inspectionId: rec.id, kind: d.kind, qty: D(d.qty), reason: d.reason, decidedBy: session.userId, clientRequestId: d.clientRequestId },
      });
    } catch (err) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "P2002") return null;
      throw err;
    }

    let outputId: string | null = null;
    if (d.kind === "scrap" || d.kind === "rework") {
      const s = await loadShopfloor(tx, session.orgId, job.id);
      const candidate = {
        id: "new",
        jobStageId: rec.jobStageId,
        goodQty: D(0),
        scrapQty: d.kind === "scrap" ? D(d.qty) : D(0),
        reworkQty: d.kind === "rework" ? D(d.qty) : D(0),
        reworkGoodQty: D(0),
        reworkScrapQty: D(0),
        reclassifiedFromGoodQty: D(d.qty),
      };
      const problems = checkInvariants([...s.outputs, candidate], s.inspections, s.stages);
      if (problems.length) throw new ValidationError(problems.join(" "));
      const o = await tx.productionOutput.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          jobStageId: rec.jobStageId,
          scrapQty: candidate.scrapQty,
          reworkQty: candidate.reworkQty,
          reclassifiedFromGoodQty: candidate.reclassifiedFromGoodQty,
          uom: rec.uom ?? "",
          reason: rec.rejectReason,
          notes: `Quality disposition: ${d.kind}`,
          source: "quality_disposition",
          inspectionId: rec.id,
          operatorUserId: session.userId,
        },
      });
      outputId = o.id;
      await recordAudit(tx, { orgId: session.orgId, branchId: job.branchId, actorUserId: session.userId, entityType: "production_output", entityId: o.id, action: "create", afterValue: { source: "quality_disposition", kind: d.kind, qty: d.qty, inspectionId: rec.id }, reason: d.reason });
    }
    await recordAudit(tx, { orgId: session.orgId, branchId: job.branchId, actorUserId: session.userId, entityType: "quality_disposition", entityId: disp.id, action: "create", afterValue: { inspectionId: rec.id, kind: d.kind, qty: d.qty, outputId }, reason: d.reason });
    return { disp, outputId };
  });

  if (!out) {
    const winner = await prisma.qualityDisposition.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
    if (!winner) throw new ConflictError("The disposition could not be recorded; retry");
    return { replayed: true, disposition: { id: winner.id, kind: winner.kind, qty: String(winner.qty) } };
  }
  return { replayed: false, disposition: { id: out.disp.id, kind: out.disp.kind, qty: String(out.disp.qty) }, outputId: out.outputId };
}
