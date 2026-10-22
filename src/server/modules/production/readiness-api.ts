// Authorised read of "can this job be completed, and if not why not" (production_job:read).
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { NotFoundError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "./job-service";
import { computeReadiness } from "./readiness";

export async function getJobReadiness(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");
  return { jobId, status: job.status, ...(await computeReadiness(prisma, session.orgId, jobId)) };
}
