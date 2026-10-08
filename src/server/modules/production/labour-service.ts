// Labour records against a job. Idempotent by (orgId, clientRequestId) so an
// offline client can retry a queued submission safely (ARCHITECTURE.md §4.B):
// a replay returns the original row and never writes a second one.
//
// First labour record on a `released` job moves it to `in_progress` and
// stamps actualStart, in the same transaction.
//
// OPEN PRODUCT POINT: the approved capability table lets PRODUCTION_OPERATOR
// record labour, and the UX spec has the operator enter the rate. That means
// an operator-typed rate flows into job cost. Consider a per-user standard
// rate later so operators only enter hours.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "./job-service";
import { acceptsWork, type JobStatus } from "./job-state";

const hasAtMostDp = (n: number, dp: number) => Math.abs(n * 10 ** dp - Math.round(n * 10 ** dp)) < 1e-6;

const labourSchema = z.object({
  clientRequestId: z.string().uuid(),
  hours: z
    .number()
    .finite()
    .positive()
    .max(24, "A single record cannot exceed 24 hours")
    .refine((n) => hasAtMostDp(n, 2), "hours supports at most 2 decimal places"),
  rate: z
    .number()
    .finite()
    .nonnegative()
    .max(1_000_000)
    .refine((n) => hasAtMostDp(n, 4), "rate supports at most 4 decimal places"),
  rateCurrency: z.string().trim().toUpperCase().length(3),
});

export interface LabourResult {
  replayed: boolean;
  record: Record<string, unknown>;
}

function toLabourView(role: AuthenticatedSession["role"], r: {
  id: string; jobId: string; userId: string | null; hours: unknown; rate: unknown; rateCurrency: string; recordedAt: Date;
}) {
  const view: Record<string, unknown> = { id: r.id, jobId: r.jobId, userId: r.userId, hours: r.hours, recordedAt: r.recordedAt };
  if (hasCapability(role, "cost:read")) {
    view.rate = r.rate;
    view.rateCurrency = r.rateCurrency;
  }
  return view;
}

export async function recordLabour(session: AuthenticatedSession, jobId: string, input: unknown): Promise<LabourResult> {
  assertCapability(session.role, "labour:record");
  const parsed = labourSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid labour payload", parsed.error.issues);
  const data = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  // Idempotent replay is checked BEFORE the job-status rule, so a retried
  // submission still succeeds even if the job has since completed.
  const existing = await prisma.labourRecord.findFirst({ where: { orgId: session.orgId, clientRequestId: data.clientRequestId } });
  if (existing) return replay(session, existing, job.id, data);

  if (!acceptsWork(job.status as JobStatus)) {
    throw new ConflictError(`Labour cannot be recorded on a job that is "${job.status}" (it must be released or in progress)`);
  }

  const currency = await prisma.currency.findUnique({ where: { code: data.rateCurrency } });
  if (!currency) throw new ValidationError(`Unknown currency code "${data.rateCurrency}"`);

  try {
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.labourRecord.create({
        data: {
          orgId: session.orgId,
          jobId: job.id,
          userId: session.userId, // always the caller: nobody logs hours as someone else
          hours: new Prisma.Decimal(data.hours),
          rate: new Prisma.Decimal(data.rate),
          rateCurrency: data.rateCurrency,
          clientRequestId: data.clientRequestId,
        },
      });

      if (job.status === "released") {
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
            reason: "first labour record",
          });
        }
      }

      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: job.branchId,
        actorUserId: session.userId,
        entityType: "labour_record",
        entityId: created.id,
        action: "create",
        afterValue: { jobId: job.id, hours: data.hours, rate: data.rate, rateCurrency: data.rateCurrency },
      });
      return created;
    });
    return { replayed: false, record: toLabourView(session.role, record) };
  } catch (err) {
    // Two identical submissions racing: the loser hits the unique index and
    // gets the winner's row back instead of an error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.labourRecord.findFirst({ where: { orgId: session.orgId, clientRequestId: data.clientRequestId } });
      if (winner) return replay(session, winner, job.id, data);
    }
    throw err;
  }
}

function replay(
  session: AuthenticatedSession,
  existing: { id: string; jobId: string; userId: string | null; hours: unknown; rate: unknown; rateCurrency: string; recordedAt: Date },
  jobId: string,
  data: z.infer<typeof labourSchema>,
): LabourResult {
  const same =
    existing.jobId === jobId &&
    new Prisma.Decimal(String(existing.hours)).equals(data.hours) &&
    new Prisma.Decimal(String(existing.rate)).equals(data.rate) &&
    existing.rateCurrency === data.rateCurrency;
  if (!same) {
    throw new ConflictError("clientRequestId was already used for a different labour record");
  }
  return { replayed: true, record: toLabourView(session.role, existing) };
}
