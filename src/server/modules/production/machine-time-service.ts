// Machine time against a job (Milestone 4): actual setup/run minutes,
// optionally attributed to a specific stage. Same idempotency discipline as
// labour-service.ts's recordLabour (clientRequestId replay) and the same
// append-only discipline as production output -- there is no edit/void
// endpoint here (see IMPLEMENTATION_MANIFEST.md's Milestone 4 "Known
// limitations": a mistaken entry needs a documented correction procedure,
// not a code path, until a real need for one is confirmed).
//
// This does NOT write to JobCostEstimateLine/JobCostActualLine.*OverheadCost
// -- those remain null ("unavailable until an overhead allocation method is
// approved", job-service.ts). Recording machine time only makes the actual
// setup/run minutes visible for reporting (job-cost-report.ts); it does not
// invent a $/minute overhead rate nobody has approved.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "./job-service";
import { acceptsWork, type JobStatus } from "./job-state";
import { findMachineInScope } from "./machine-service";

const recordSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    jobStageId: z.string().uuid().optional(),
    machineId: z.string().uuid(),
    setupMinutes: z.number().int().min(0).max(1440).default(0),
    runMinutes: z.number().int().min(0).max(1440).default(0),
  })
  .refine((d) => d.setupMinutes + d.runMinutes > 0, { message: "Record at least one setup or run minute", path: ["runMinutes"] });

function toView(r: { id: string; jobId: string; jobStageId: string | null; machineId: string; setupMinutes: number; runMinutes: number; operatorUserId: string | null; recordedAt: Date }) {
  return { id: r.id, jobId: r.jobId, jobStageId: r.jobStageId, machineId: r.machineId, setupMinutes: r.setupMinutes, runMinutes: r.runMinutes, operatorUserId: r.operatorUserId, recordedAt: r.recordedAt };
}

export async function recordMachineTime(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "machine_time:record");
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid machine-time payload", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const existing = await prisma.machineTimeRecord.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (existing) {
    const same =
      existing.jobId === job.id &&
      (existing.jobStageId ?? null) === (d.jobStageId ?? null) &&
      existing.machineId === d.machineId &&
      existing.setupMinutes === d.setupMinutes &&
      existing.runMinutes === d.runMinutes;
    if (!same) throw new ConflictError("clientRequestId was already used for a different machine-time record");
    return { replayed: true, record: toView(existing) };
  }

  if (!acceptsWork(job.status as JobStatus)) {
    throw new ConflictError(`Machine time cannot be recorded on a job that is "${job.status}" (it must be released or in progress)`);
  }

  const machine = await findMachineInScope(session, d.machineId);
  if (!machine) throw new ValidationError("machineId does not belong to a machine you can access");

  if (d.jobStageId) {
    const stage = await prisma.productionJobStage.findFirst({ where: { orgId: session.orgId, id: d.jobStageId, jobId: job.id } });
    if (!stage) throw new ValidationError("jobStageId does not belong to this job");
  }

  try {
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.machineTimeRecord.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          jobStageId: d.jobStageId ?? null,
          machineId: d.machineId,
          setupMinutes: d.setupMinutes,
          runMinutes: d.runMinutes,
          operatorUserId: session.userId,
          clientRequestId: d.clientRequestId,
        },
      });
      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: job.branchId,
        actorUserId: session.userId,
        entityType: "machine_time_record",
        entityId: created.id,
        action: "create",
        afterValue: { jobId: job.id, jobStageId: d.jobStageId ?? null, machineId: d.machineId, setupMinutes: d.setupMinutes, runMinutes: d.runMinutes },
      });
      return created;
    });
    return { replayed: false, record: toView(record) };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.machineTimeRecord.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
      if (winner) return { replayed: true, record: toView(winner) };
    }
    throw err;
  }
}

export async function listMachineTime(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const rows = await prisma.machineTimeRecord.findMany({ where: { orgId: session.orgId, jobId }, orderBy: [{ recordedAt: "desc" }, { id: "desc" }] });
  const totals = rows.reduce((t, r) => ({ setupMinutes: t.setupMinutes + r.setupMinutes, runMinutes: t.runMinutes + r.runMinutes }), { setupMinutes: 0, runMinutes: 0 });
  return { jobId, entries: rows.map(toView), totals };
}
