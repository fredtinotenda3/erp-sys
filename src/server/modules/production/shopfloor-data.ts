// Loads the rows the pure shop-floor rules (shopfloor-math.ts) need, from either
// the main client or a transaction, plus the small write helpers every
// shop-floor service shares.
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import {
  jobTotals,
  type InspectionRow,
  type OutputRow,
  type StageState,
} from "./shopfloor-math";

export type Db = Prisma.TransactionClient;

const D = (v: unknown) => new Prisma.Decimal(String(v));

export interface LoadedShopfloor {
  stages: (StageState & {
    plannedStart: Date | null;
    plannedEnd: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    workCentre: string | null;
    operatorUserId: string | null;
    blockedReason: string | null;
    blockedAt: Date | null;
    notes: string | null;
  })[];
  /** Entries that have NOT been voided. */
  outputs: (OutputRow & { id: string })[];
  inspections: (InspectionRow & { id: string; outcome: string; rejectReason: string | null; dispositions: { kind: string; qty: Prisma.Decimal }[] })[];
}

export async function loadShopfloor(db: Db | typeof prisma, orgId: string, jobId: string): Promise<LoadedShopfloor> {
  const [stages, outputs, inspections] = await Promise.all([
    db.productionJobStage.findMany({ where: { orgId, jobId }, orderBy: { sequence: "asc" } }),
    db.productionOutput.findMany({ where: { orgId, jobId, void: null }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] }),
    db.qualityRecord.findMany({ where: { orgId, jobId }, include: { dispositions: true }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] }),
  ]);
  return {
    stages: stages.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      name: s.stageName,
      status: s.status,
      blocked: s.blockedReason !== null,
      requiresInspection: s.requiresInspection,
      plannedStart: s.plannedStart,
      plannedEnd: s.plannedEnd,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      workCentre: s.workCentre,
      operatorUserId: s.operatorUserId,
      blockedReason: s.blockedReason,
      blockedAt: s.blockedAt,
      notes: s.notes,
    })),
    outputs: outputs.map((o) => ({
      id: o.id,
      jobStageId: o.jobStageId,
      goodQty: D(o.goodQty),
      scrapQty: D(o.scrapQty),
      reworkQty: D(o.reworkQty),
      reworkGoodQty: D(o.reworkGoodQty),
      reworkScrapQty: D(o.reworkScrapQty),
      reclassifiedFromGoodQty: D(o.reclassifiedFromGoodQty),
    })),
    inspections: inspections.map((q) => ({
      id: q.id,
      jobStageId: q.jobStageId,
      producedQty: D(q.producedQty),
      acceptedQty: D(q.acceptedQty),
      rejectedQty: D(q.rejectedQty),
      dispositionedQty: q.dispositions.reduce((t, d) => t.add(D(d.qty)), D(0)),
      outcome: q.outcome ?? (D(q.rejectedQty).isZero() ? "pass" : "fail"),
      rejectReason: q.rejectReason,
      dispositions: q.dispositions.map((d) => ({ kind: d.kind, qty: D(d.qty) })),
    })),
  };
}

/**
 * Serialises shop-floor writes on one job so cumulative checks (units inspected,
 * rework resolved...) are exact. Completion uses a different lock key (7), and
 * the DB triggers take key 7 shared, so this cannot deadlock with completion.
 */
export async function lockShopfloor(tx: Db, jobId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${jobId}, 13))`;
}

/** Same first-activity rule as the first material issue: released -> in_progress, once. */
export async function startJobIfReleased(
  tx: Db,
  session: AuthenticatedSession,
  job: { id: string; branchId: string; status: string },
  reason: string,
): Promise<void> {
  if (job.status !== "released") return;
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
      reason,
    });
  }
}

/** Frozen into the completion snapshot's evidence. */
export async function summarizeShopfloor(db: Db, orgId: string, jobId: string) {
  const s = await loadShopfloor(db, orgId, jobId);
  const t = jobTotals(s.stages, s.outputs);
  const failed = s.inspections.filter((i) => i.outcome === "fail");
  return {
    stages: { total: s.stages.length, completed: s.stages.filter((x) => x.status === "completed").length },
    output: t,
    inspections: {
      total: s.inspections.length,
      passed: s.inspections.length - failed.length,
      failed: failed.length,
      rejectedUnits: s.inspections.reduce((a, i) => a.add(i.rejectedQty), D(0)).toString(),
      dispositionedUnits: s.inspections.reduce((a, i) => a.add(i.dispositionedQty), D(0)).toString(),
    },
  };
}

export type { OutputRow, InspectionRow, StageState };
