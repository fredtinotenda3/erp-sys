// Read-only, cross-job views for the Quality screens. Everything here reuses the existing
// quality/readiness rules (toInspectionView, computeReadiness); it adds no quality logic of
// its own. Recording results and dispositions stays in quality-service.ts, whose per-job
// capability, branch and job-state checks are the only write path.
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertBranchAccess, assertCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";
import { computeReadiness } from "./readiness";
import { toInspectionView } from "./quality-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_JOB_STATUSES = ["released", "in_progress", "on_hold"] as const;
const D = (v: unknown) => new Prisma.Decimal(String(v));

function jobScope(session: AuthenticatedSession, branchId?: string): Prisma.ProductionJobWhereInput {
  if (branchId) {
    if (!UUID_RE.test(branchId)) throw new ValidationError("Invalid branchId");
    assertBranchAccess(session, branchId);
    return { orgId: session.orgId, branchId };
  }
  return session.role === "OWNER_ADMIN" ? { orgId: session.orgId } : { orgId: session.orgId, branchId: { in: [...session.branchIds] } };
}

export interface InspectionListFilter {
  branchId?: string;
  outcome?: "pass" | "fail";
  /** Only inspections with rejected units that still need a disposition. */
  openOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listInspectionsAcrossJobs(session: AuthenticatedSession, filter: InspectionListFilter = {}) {
  assertCapability(session.role, "quality:read");
  assertCapability(session.role, "production_job:read");
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 25), 1), 100);
  const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
  if (filter.outcome && filter.outcome !== "pass" && filter.outcome !== "fail") throw new ValidationError("Invalid outcome filter");

  const jobWhere = jobScope(session, filter.branchId);
  const base: Prisma.QualityRecordWhereInput = {
    orgId: session.orgId,
    job: jobWhere,
    ...(filter.outcome === "fail" ? { rejectedQty: { gt: 0 } } : filter.outcome === "pass" ? { rejectedQty: 0 } : {}),
  };

  if (filter.openOnly) {
    // "Open" depends on dispositions, so evaluate over the failed set (bounded) rather than in SQL.
    const failed = await prisma.qualityRecord.findMany({
      where: { ...base, rejectedQty: { gt: 0 } },
      include: { dispositions: true, job: { select: { jobNumber: true, status: true, branchId: true } }, jobStage: { select: { stageName: true } } },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: 1000,
    });
    const open = failed.filter((r) => D(r.rejectedQty).sub(r.dispositions.reduce((t, d) => t.add(D(d.qty)), D(0))).gt(0));
    return { total: open.length, limit, offset, rows: open.slice(offset, offset + limit).map(toRow) };
  }

  const [total, rows] = await Promise.all([
    prisma.qualityRecord.count({ where: base }),
    prisma.qualityRecord.findMany({
      where: base,
      include: { dispositions: { orderBy: { decidedAt: "asc" } }, job: { select: { jobNumber: true, status: true, branchId: true } }, jobStage: { select: { stageName: true } } },
      orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
    }),
  ]);
  return { total, limit, offset, rows: rows.map(toRow) };
}

type RowIn = Parameters<typeof toInspectionView>[0] & { job: { jobNumber: string; status: string; branchId: string }; jobStage: { stageName: string } | null };
function toRow(r: unknown) {
  const x = r as RowIn;
  return { ...toInspectionView(x), jobId: (x as unknown as { jobId: string }).jobId, jobNumber: x.job.jobNumber, jobStatus: x.job.status, branchId: x.job.branchId, stageName: x.jobStage?.stageName ?? null };
}

/**
 * Open jobs that cannot be completed because of unresolved quality or shop-floor state, with
 * the server's own blocker text (the same check that refuses completion). Bounded to the 200
 * most recently updated open jobs that use stages or have inspections.
 */
export async function listBlockedJobs(session: AuthenticatedSession, filter: { branchId?: string } = {}) {
  assertCapability(session.role, "quality:read");
  assertCapability(session.role, "production_job:read");
  const candidates = await prisma.productionJob.findMany({
    where: { ...jobScope(session, filter.branchId), status: { in: [...OPEN_JOB_STATUSES] }, OR: [{ stages: { some: {} } }, { qualityRecords: { some: {} } }] },
    select: { id: true, jobNumber: true, status: true, branchId: true, productItem: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const out = [];
  for (const j of candidates) {
    const readiness = await computeReadiness(prisma, session.orgId, j.id);
    if (readiness.canComplete) continue;
    const recs = await prisma.qualityRecord.findMany({ where: { orgId: session.orgId, jobId: j.id, rejectedQty: { gt: 0 } }, include: { dispositions: true } });
    const openRejected = recs.reduce((t, r) => t.add(D(r.rejectedQty).sub(r.dispositions.reduce((s, d) => s.add(D(d.qty)), D(0)))), D(0));
    out.push({ jobId: j.id, jobNumber: j.jobNumber, status: j.status, branchId: j.branchId, product: j.productItem.name, openRejectedUnits: openRejected.toString(), blockers: readiness.jobBlockers });
  }
  return { jobs: out, examined: candidates.length };
}

/** One inspection with its job, for the detail screen. Out-of-scope or unknown ids are "not found". */
export async function getInspectionById(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "quality:read");
  assertCapability(session.role, "production_job:read");
  if (!UUID_RE.test(id)) throw new NotFoundError("Inspection");
  const rec = await prisma.qualityRecord.findFirst({
    where: { orgId: session.orgId, id, job: jobScope(session) },
    include: { dispositions: { orderBy: { decidedAt: "asc" } }, job: { select: { jobNumber: true, status: true, branchId: true, productItem: { select: { name: true, sku: true, uom: true } } } }, jobStage: { select: { stageName: true } } },
  });
  if (!rec) throw new NotFoundError("Inspection");
  return { ...toInspectionView(rec), jobId: rec.jobId, jobNumber: rec.job.jobNumber, jobStatus: rec.job.status, branchId: rec.job.branchId, stageName: rec.jobStage?.stageName ?? null, product: rec.job.productItem };
}
