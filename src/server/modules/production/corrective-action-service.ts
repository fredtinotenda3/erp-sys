// Corrective actions (Milestone 4): the root-cause follow-up on a quality
// problem, distinct from QualityDisposition (which only ever decides what
// happens to the REJECTED UNITS -- scrap/rework/use_as_is, quality-
// service.ts). A failed inspection (quality_record) together with its
// dispositions already functions as this codebase's non-conformance
// record; this model is the tracked response to it (e.g. "recalibrate
// machine X"), which may legitimately outlive the job it was raised on.
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "./job-service";

const STATUS_VALUES = ["open", "in_progress", "completed", "cancelled"] as const;

const createSchema = z.object({
  qualityRecordId: z.string().uuid().optional(),
  description: z.string().trim().min(5, "Describe the corrective action in at least 5 characters").max(1000),
  assignedToUserId: z.string().uuid().optional(),
  dueDate: z.coerce.date().optional(),
});

const updateSchema = z
  .object({
    status: z.enum(STATUS_VALUES),
    assignedToUserId: z.string().uuid().nullable(),
    dueDate: z.coerce.date().nullable(),
    resolutionNotes: z.string().trim().max(1000),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update")
  .superRefine((d, ctx) => {
    if ((d.status === "completed" || d.status === "cancelled") && !d.resolutionNotes) {
      ctx.addIssue({ code: "custom", message: "resolutionNotes is required when closing a corrective action", path: ["resolutionNotes"] });
    }
  });

function toView(r: {
  id: string; jobId: string; qualityRecordId: string | null; description: string; assignedToUserId: string | null;
  status: string; dueDate: Date | null; resolvedAt: Date | null; resolutionNotes: string | null; createdById: string | null; createdAt: Date; updatedAt: Date;
}) {
  return { ...r };
}

export async function createCorrectiveAction(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "corrective_action:manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid corrective action payload", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  if (d.assignedToUserId) {
    const u = await prisma.user.findFirst({ where: { id: d.assignedToUserId, orgId: session.orgId, isActive: true } });
    if (!u) throw new ValidationError("assignedToUserId is not an active user of this organization");
  }
  if (d.qualityRecordId) {
    const rec = await prisma.qualityRecord.findFirst({ where: { orgId: session.orgId, id: d.qualityRecordId, jobId: job.id } });
    if (!rec) throw new ValidationError("qualityRecordId does not belong to this job");
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.correctiveAction.create({
      data: {
        orgId: session.orgId,
        jobId: job.id,
        qualityRecordId: d.qualityRecordId ?? null,
        description: d.description,
        assignedToUserId: d.assignedToUserId ?? null,
        dueDate: d.dueDate ?? null,
        createdById: session.userId,
      },
    });
    await recordAudit(tx, { orgId: session.orgId, branchId: job.branchId, actorUserId: session.userId, entityType: "corrective_action", entityId: row.id, action: "create", afterValue: { jobId: job.id, qualityRecordId: d.qualityRecordId ?? null } });
    return row;
  });
  return toView(created);
}

export async function listCorrectiveActions(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "quality:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const rows = await prisma.correctiveAction.findMany({ where: { orgId: session.orgId, jobId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
  return rows.map(toView);
}

export async function updateCorrectiveAction(session: AuthenticatedSession, jobId: string, actionId: string, input: unknown) {
  assertCapability(session.role, "corrective_action:manage");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid update", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  const row = await prisma.correctiveAction.findFirst({ where: { orgId: session.orgId, id: actionId, jobId: job.id } });
  if (!row) throw new NotFoundError("Corrective action");
  if (row.status === "completed" || row.status === "cancelled") {
    throw new ConflictError(`This corrective action is already "${row.status}" and can no longer be changed`);
  }

  if (d.assignedToUserId) {
    const u = await prisma.user.findFirst({ where: { id: d.assignedToUserId, orgId: session.orgId, isActive: true } });
    if (!u) throw new ValidationError("assignedToUserId is not an active user of this organization");
  }

  const closing = d.status === "completed" || d.status === "cancelled";
  const data: Record<string, unknown> = { ...d };
  if (closing) data.resolvedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const res = await tx.correctiveAction.updateMany({ where: { id: row.id, orgId: session.orgId, status: row.status }, data });
    if (res.count !== 1) throw new ConflictError("This corrective action was changed by someone else — reload and retry");
    await recordAudit(tx, { orgId: session.orgId, branchId: job.branchId, actorUserId: session.userId, entityType: "corrective_action", entityId: row.id, action: "update", beforeValue: { status: row.status }, afterValue: d });
    return tx.correctiveAction.findFirst({ where: { id: row.id } });
  });
  return toView(updated!);
}
