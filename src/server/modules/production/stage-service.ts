// Production stages (routing) for one job.
//
// A job may optionally be given an ordered routing. Once it has one:
//   - stages run strictly in sequence (a stage starts only after earlier ones complete);
//   - a stage cannot be completed by flipping a status: it needs recorded output,
//     no units left in rework, no undispositioned rejects and, where flagged,
//     a recorded inspection covering every good unit;
//   - the job cannot be completed until every stage is (see readiness.ts).
// Authorization: defining/changing the routing is a planning act
// (production_job:update); starting/completing/blocking is shop-floor work
// (stage:transition). The database independently refuses illegal transitions and
// any change once the job is no longer open (migration 20261022100000).
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { acceptsWork, type JobStatus } from "./job-state";
import { findJobInScope } from "./job-service";
import { loadShopfloor, lockShopfloor, startJobIfReleased, type LoadedShopfloor } from "./shopfloor-data";
import { startBlockers, stageCompletionBlockers, totalsByStage, totalsOf, type StageState } from "./shopfloor-math";

const defineSchema = z.object({
  stages: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        plannedStart: z.coerce.date().nullish(),
        plannedEnd: z.coerce.date().nullish(),
        workCentre: z.string().trim().max(100).nullish(),
        operatorUserId: z.string().uuid().nullish(),
        requiresInspection: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(50),
});

const transitionSchema = z.object({
  action: z.enum(["start", "complete", "block", "unblock"]),
  reason: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export type StageView = Awaited<ReturnType<typeof listStages>>["stages"][number];

function inspectionState(stage: StageState, ins: LoadedShopfloor["inspections"], grossGood: Prisma.Decimal) {
  const mine = ins.filter((i) => i.jobStageId === stage.id);
  const inspected = mine.reduce((a, i) => a.add(i.producedQty), new Prisma.Decimal(0));
  const rejected = mine.reduce((a, i) => a.add(i.rejectedQty), new Prisma.Decimal(0));
  const openRejected = mine.reduce((a, i) => a.add(i.rejectedQty.sub(i.dispositionedQty)), new Prisma.Decimal(0));
  let state: "not_required" | "pending" | "passed" | "failed_open" | "failed_resolved";
  if (openRejected.gt(0)) state = "failed_open";
  else if (rejected.gt(0)) state = inspected.gte(grossGood) ? "failed_resolved" : "pending";
  else if (!stage.requiresInspection && mine.length === 0) state = "not_required";
  else if (inspected.isZero() || inspected.lt(grossGood)) state = stage.requiresInspection ? "pending" : "passed";
  else state = "passed";
  return { state, inspected: inspected.toString(), rejected: rejected.toString(), openRejected: openRejected.toString() };
}

export async function listStages(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const s = await loadShopfloor(prisma, session.orgId, jobId);
  const byStage = totalsByStage(s.outputs);
  const now = Date.now();
  const stages = s.stages.map((st) => {
    const t = byStage.get(st.id) ?? totalsOf([]);
    return {
      id: st.id,
      sequence: st.sequence,
      name: st.name,
      status: st.status,
      plannedStart: st.plannedStart,
      plannedEnd: st.plannedEnd,
      startedAt: st.startedAt,
      completedAt: st.completedAt,
      workCentre: st.workCentre,
      operatorUserId: st.operatorUserId,
      requiresInspection: st.requiresInspection,
      blockedReason: st.blockedReason,
      blockedAt: st.blockedAt,
      notes: st.notes,
      // Delayed = past its planned end and not finished. Derived, never stored.
      isDelayed: st.status !== "completed" && st.plannedEnd !== null && st.plannedEnd.getTime() < now,
      output: t,
      inspection: inspectionState(st, s.inspections, new Prisma.Decimal(t.grossGood)),
      completionBlockers:
        st.status === "in_progress" ? stageCompletionBlockers(st, s.outputs, s.inspections) : [],
    };
  });
  return { jobId, stages };
}

async function assertAssignable(orgId: string, branchId: string, userId: string | null | undefined) {
  if (!userId) return;
  const u = await prisma.user.findFirst({ where: { id: userId, orgId, isActive: true } });
  if (!u) throw new ValidationError("The assigned operator isn't an active user of this organization");
  if (u.role === "OWNER_ADMIN") return;
  const access = await prisma.userBranchAccess.findFirst({ where: { orgId, userId, branchId } });
  if (!access) throw new ValidationError("The assigned operator doesn't have access to this job's branch");
}

/** Replaces the routing. Only while nothing has started and nothing has been recorded. */
export async function defineStages(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "production_job:update");
  const parsed = defineSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid stage routing", parsed.error.issues);
  const stages = parsed.data.stages;

  const names = new Set<string>();
  for (const [i, s] of stages.entries()) {
    const key = s.name.toLowerCase();
    if (names.has(key)) throw new ValidationError(`Stage name "${s.name}" is used twice`);
    names.add(key);
    if (s.plannedStart && s.plannedEnd && s.plannedEnd < s.plannedStart) {
      throw new ValidationError(`Stage ${i + 1} "${s.name}": planned end can't be before planned start`);
    }
  }

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  if (job.status !== "planned" && job.status !== "released") {
    throw new ConflictError("The routing can only be defined before the job has started");
  }
  for (const s of stages) await assertAssignable(session.orgId, job.branchId, s.operatorUserId);

  await prisma.$transaction(async (tx) => {
    await lockShopfloor(tx, job.id);
    const cur = await tx.productionJob.findFirst({ where: { id: job.id, orgId: session.orgId }, select: { status: true } });
    if (!cur || (cur.status !== "planned" && cur.status !== "released")) {
      throw new ConflictError("The routing can only be defined before the job has started");
    }
    const existing = await tx.productionJobStage.findMany({ where: { orgId: session.orgId, jobId: job.id } });
    if (existing.some((e) => e.status !== "pending")) throw new ConflictError("A stage has already started; the routing can no longer be replaced");
    const hasOutput = (await tx.productionOutput.count({ where: { orgId: session.orgId, jobId: job.id } })) + (await tx.qualityRecord.count({ where: { orgId: session.orgId, jobId: job.id } }));
    if (hasOutput > 0) throw new ConflictError("Output or inspections already exist for this job; the routing can no longer be replaced");

    if (existing.length > 0) await tx.productionJobStage.deleteMany({ where: { orgId: session.orgId, jobId: job.id } });
    for (const [i, s] of stages.entries()) {
      const row = await tx.productionJobStage.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          stageName: s.name,
          sequence: i + 1,
          plannedStart: s.plannedStart ?? null,
          plannedEnd: s.plannedEnd ?? null,
          workCentre: s.workCentre || null,
          operatorUserId: s.operatorUserId ?? null,
          requiresInspection: s.requiresInspection,
        },
      });
      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: job.branchId,
        actorUserId: session.userId,
        entityType: "production_job_stage",
        entityId: row.id,
        action: "create",
        afterValue: { jobId: job.id, sequence: i + 1, name: s.name, requiresInspection: s.requiresInspection, workCentre: s.workCentre ?? null },
      });
    }
  });
  return listStages(session, jobId);
}

export async function transitionStage(session: AuthenticatedSession, jobId: string, stageId: string, input: unknown) {
  assertCapability(session.role, "stage:transition");
  const parsed = transitionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid stage action", parsed.error.issues);
  const { action, reason, notes } = parsed.data;
  if (action === "block" && (!reason || reason.length < 3)) throw new ValidationError("A reason (at least 3 characters) is required to block a stage");

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  await prisma.$transaction(async (tx) => {
    await lockShopfloor(tx, job.id);
    const jobNow = await tx.productionJob.findFirst({ where: { id: job.id, orgId: session.orgId }, select: { status: true, branchId: true, id: true } });
    if (!jobNow) throw new NotFoundError("Production job");
    if (!acceptsWork(jobNow.status as JobStatus)) {
      throw new ConflictError(`Job is "${jobNow.status.replace(/_/g, " ")}" and does not accept shop-floor work`);
    }
    const s = await loadShopfloor(tx, session.orgId, job.id);
    const stage = s.stages.find((x) => x.id === stageId);
    if (!stage) throw new NotFoundError("Stage");

    const audit = (a: "transition" | "update", before: unknown, after: unknown, why?: string) =>
      recordAudit(tx, { orgId: session.orgId, branchId: job.branchId, actorUserId: session.userId, entityType: "production_job_stage", entityId: stage.id, action: a, beforeValue: before, afterValue: after, reason: why });

    if (action === "start") {
      const b = startBlockers(stage, s.stages);
      if (stage.blocked) b.push(`Stage "${stage.name}" is blocked; unblock it first.`);
      if (b.length) throw new ConflictError(b.join(" "));
      await startJobIfReleased(tx, session, jobNow, "first stage started");
      const r = await tx.productionJobStage.updateMany({
        where: { id: stage.id, orgId: session.orgId, status: "pending" },
        data: { status: "in_progress", startedAt: new Date(), operatorUserId: stage.operatorUserId ?? session.userId, ...(notes ? { notes } : {}) },
      });
      if (r.count !== 1) throw new ConflictError("The stage was changed by someone else; reload and retry");
      await audit("transition", { status: "pending" }, { status: "in_progress" }, reason);
    } else if (action === "complete") {
      const b = stageCompletionBlockers(stage, s.outputs, s.inspections);
      if (b.length) throw new ConflictError(`Stage can't be completed yet: ${b.join(" ")}`);
      const r = await tx.productionJobStage.updateMany({
        where: { id: stage.id, orgId: session.orgId, status: "in_progress", blockedReason: null },
        data: { status: "completed", completedAt: new Date(), ...(notes ? { notes } : {}) },
      });
      if (r.count !== 1) throw new ConflictError("The stage was changed by someone else; reload and retry");
      await audit("transition", { status: "in_progress" }, { status: "completed" }, reason);
    } else if (action === "block") {
      if (stage.status === "completed") throw new ConflictError("A completed stage can't be blocked");
      if (stage.blocked) throw new ConflictError("The stage is already blocked");
      const r = await tx.productionJobStage.updateMany({
        where: { id: stage.id, orgId: session.orgId, blockedReason: null, status: { not: "completed" } },
        data: { blockedReason: reason!, blockedAt: new Date(), blockedById: session.userId },
      });
      if (r.count !== 1) throw new ConflictError("The stage was changed by someone else; reload and retry");
      await audit("update", { blocked: false }, { blocked: true }, reason);
    } else {
      if (!stage.blocked) throw new ConflictError("The stage is not blocked");
      const r = await tx.productionJobStage.updateMany({
        where: { id: stage.id, orgId: session.orgId, blockedReason: { not: null } },
        data: { blockedReason: null, blockedAt: null, blockedById: null },
      });
      if (r.count !== 1) throw new ConflictError("The stage was changed by someone else; reload and retry");
      await audit("update", { blocked: true, reason: stage.blockedReason }, { blocked: false }, reason);
    }
  });
  const all = await listStages(session, jobId);
  return all.stages.find((x) => x.id === stageId)!;
}
