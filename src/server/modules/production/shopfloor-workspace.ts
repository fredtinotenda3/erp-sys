// The operator workspace's job list. It is a READ model over existing jobs and stages -- it
// starts, records and decides nothing. All work still goes through the stage, output, labour and
// quality services (which enforce capability, branch scope and job-state rules).
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ValidationError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKING = ["released", "in_progress", "on_hold"] as const;

export interface WorkspaceJob {
  id: string;
  jobNumber: string;
  status: string;
  branchId: string;
  product: string;
  plannedQty: string;
  uom: string;
  plannedEnd: string | null;
  /** The stage someone is on now (first in progress), else the next one waiting. */
  currentStage: string | null;
  stagesDone: number;
  stagesTotal: number;
  blockedStage: string | null;
  assignedToMe: boolean;
}

// Deliberately no customer, quote, cost or order fields: this list is shown to operators.
export async function listWorkspaceJobs(session: AuthenticatedSession, filter: { branchId?: string } = {}): Promise<WorkspaceJob[]> {
  assertCapability(session.role, "production_job:read");
  if (filter.branchId && !UUID_RE.test(filter.branchId)) throw new ValidationError("Invalid branchId");
  const scope = filter.branchId
    ? session.role === "OWNER_ADMIN" || session.branchIds.includes(filter.branchId)
      ? { branchId: filter.branchId }
      : { branchId: { in: [] as string[] } } // a branch they can't access shows nothing, never an error that confirms it exists
    : session.role === "OWNER_ADMIN"
      ? {}
      : { branchId: { in: [...session.branchIds] } };

  const jobs = await prisma.productionJob.findMany({
    where: { orgId: session.orgId, ...scope, status: { in: [...WORKING] } },
    select: {
      id: true, jobNumber: true, status: true, branchId: true, plannedQty: true, plannedEnd: true,
      productItem: { select: { name: true, uom: true } },
      stages: { select: { stageName: true, sequence: true, status: true, operatorUserId: true, blockedReason: true }, orderBy: { sequence: "asc" } },
    },
    orderBy: [{ plannedEnd: { sort: "asc", nulls: "last" } }, { jobNumber: "asc" }],
    take: 100,
  });

  const out = jobs.map((j): WorkspaceJob => {
    const active = j.stages.find((s) => s.status === "in_progress") ?? j.stages.find((s) => s.status === "pending");
    const blocked = j.stages.find((s) => s.blockedReason && s.status !== "completed");
    return {
      id: j.id,
      jobNumber: j.jobNumber,
      status: j.status,
      branchId: j.branchId,
      product: j.productItem.name,
      plannedQty: j.plannedQty.toString(),
      uom: j.productItem.uom,
      plannedEnd: j.plannedEnd ? j.plannedEnd.toISOString() : null,
      currentStage: active?.stageName ?? null,
      stagesDone: j.stages.filter((s) => s.status === "completed").length,
      stagesTotal: j.stages.length,
      blockedStage: blocked?.stageName ?? null,
      assignedToMe: j.stages.some((s) => s.operatorUserId === session.userId && s.status !== "completed"),
    };
  });
  // Work assigned to the caller first, then everything else they can reach.
  return out.sort((a, b) => Number(b.assignedToMe) - Number(a.assignedToMe));
}
