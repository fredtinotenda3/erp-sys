// Plastics process detail (Milestone 6): the process-type/mould/cycle-time/
// cavity record for one production job stage -- injection moulding, blow
// moulding, ISBM, preform production, bottle production, cap/closure
// production, etc. "Represent these as configurable process types and
// operation workflows, not one hardcoded universal production sequence"
// (mandate §8) is why processType is free text with suggested values (same
// reasoning as PlasticsProductSpec.productType in plastics-item-service.ts),
// not a Prisma enum that would need a migration for every new process a
// plant runs.
//
// 1:1 extension of ProductionJobStage, same shape as PlasticsMaterialAttributes/
// PlasticsProductSpec's 1:1 extension of Item in plastics-item-service.ts.
//
// Locking: once the stage reaches its terminal status ("completed" -- see
// schema.prisma's ProductionJobStageStatus; "blocked" is not a stage-level
// status in this schema), process detail can no longer be changed --
// mirrors corrective-action-service.ts's own precedent for service-layer-
// enforced immutability (no DB trigger; a reasoned ConflictError instead,
// with the same optimistic updateMany-count-guard pattern that file uses to
// catch a stage completing concurrently with this write).
//
// actualCycleTimeSeconds is always operator-entered: this codebase has no
// PLC/telemetry integration anywhere, and the mandate explicitly says "do
// not invent machine telemetry ... when no connected equipment provides
// them" -- see plastics-analytics-service.ts, which reads this field back
// and labels it accordingly rather than presenting it as a measured sensor
// reading.
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability, hasBranchAccess } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { assertPlasticsProfileActive } from "../industry/industry-profile-service";

async function findStageInScope(session: AuthenticatedSession, jobStageId: string) {
  const stage = await prisma.productionJobStage.findFirst({
    where: { orgId: session.orgId, id: jobStageId },
    include: { job: true },
  });
  if (!stage) return null;
  if (!hasBranchAccess(session, stage.job.branchId)) return null;
  return stage;
}

const setSchema = z
  .object({
    processType: z.string().trim().min(1).max(60),
    mouldId: z.string().uuid().nullable(),
    targetCycleTimeSeconds: z.number().positive().max(100_000).nullable(),
    actualCycleTimeSeconds: z.number().positive().max(100_000).nullable(),
    totalCavities: z.number().int().positive().max(1000).nullable(),
    goodCavities: z.number().int().min(0).max(1000).nullable(),
  })
  .partial()
  .strict();

/** Read: reuses production_job:read, same as every other job-stage sub-view. Never profile-gated. */
export async function getPlasticsProcessDetail(session: AuthenticatedSession, jobStageId: string) {
  assertCapability(session.role, "production_job:read");
  const stage = await findStageInScope(session, jobStageId);
  if (!stage) throw new NotFoundError("Production job stage");
  return prisma.plasticsProcessDetail.findFirst({ where: { orgId: session.orgId, jobStageId } });
}

export async function setPlasticsProcessDetail(session: AuthenticatedSession, jobStageId: string, input: unknown) {
  assertCapability(session.role, "plastics_process:record");
  await assertPlasticsProfileActive(session);
  const parsed = setSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid plastics process detail payload", parsed.error.issues);
  const d = parsed.data;

  const stage = await findStageInScope(session, jobStageId);
  if (!stage) throw new NotFoundError("Production job stage");
  if (stage.status === "completed") {
    throw new ConflictError("This stage is completed -- its plastics process detail can no longer be changed");
  }

  const existing = await prisma.plasticsProcessDetail.findFirst({ where: { orgId: session.orgId, jobStageId } });
  if (!existing && d.processType === undefined) {
    throw new ValidationError("processType is required when creating plastics process detail", [{ code: "custom", message: "Required", path: ["processType"] }]);
  }

  if (d.mouldId) {
    const mould = await prisma.mould.findFirst({ where: { orgId: session.orgId, id: d.mouldId } });
    if (!mould) throw new ValidationError("mouldId is not a mould in this organization");
  }

  // Same "explicit null must win over the existing value" distinction the
  // actual `data` assignment below already makes (d.field !== undefined,
  // not `??`) -- using `??` here instead would let an explicit
  // totalCavities: null incorrectly fall back to the EXISTING totalCavities
  // for this check while the write below correctly nulls it, which could
  // reject a legitimate request (e.g. clearing totalCavities while raising
  // goodCavities) against a total that is about to stop applying.
  const totalCavities = d.totalCavities !== undefined ? d.totalCavities : existing?.totalCavities ?? null;
  const goodCavities = d.goodCavities !== undefined ? d.goodCavities : existing?.goodCavities ?? null;
  if (totalCavities !== null && goodCavities !== null && goodCavities > totalCavities) {
    throw new ValidationError("goodCavities cannot exceed totalCavities", [{ code: "custom", message: "Out of range", path: ["goodCavities"] }]);
  }

  const data = {
    orgId: session.orgId,
    jobStageId,
    processType: d.processType ?? existing?.processType,
    mouldId: d.mouldId !== undefined ? d.mouldId : existing?.mouldId ?? null,
    targetCycleTimeSeconds: d.targetCycleTimeSeconds !== undefined ? d.targetCycleTimeSeconds : existing?.targetCycleTimeSeconds ?? null,
    actualCycleTimeSeconds: d.actualCycleTimeSeconds !== undefined ? d.actualCycleTimeSeconds : existing?.actualCycleTimeSeconds ?? null,
    totalCavities: d.totalCavities !== undefined ? d.totalCavities : existing?.totalCavities ?? null,
    goodCavities: d.goodCavities !== undefined ? d.goodCavities : existing?.goodCavities ?? null,
  } as { processType: string } & Record<string, unknown>;

  return prisma.$transaction(async (tx) => {
    let row;
    if (existing) {
      // Re-checks the stage hasn't completed concurrently since the read
      // above, same guard discipline as corrective-action-service.ts's
      // updateCorrectiveAction.
      const stillOpen = await tx.productionJobStage.findFirst({ where: { id: stage.id, orgId: session.orgId, status: { not: "completed" } } });
      if (!stillOpen) throw new ConflictError("This stage was completed concurrently -- its plastics process detail can no longer be changed");
      row = await tx.plasticsProcessDetail.update({ where: { id: existing.id }, data });
    } else {
      row = await tx.plasticsProcessDetail.create({ data: data as Parameters<typeof tx.plasticsProcessDetail.create>[0]["data"] });
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: stage.job.branchId,
      actorUserId: session.userId,
      entityType: "plastics_process_detail",
      entityId: row.id,
      action: existing ? "update" : "create",
      beforeValue: existing ? { processType: existing.processType, mouldId: existing.mouldId } : undefined,
      afterValue: { jobStageId, processType: data.processType, mouldId: data.mouldId },
    });
    return row;
  });
}
