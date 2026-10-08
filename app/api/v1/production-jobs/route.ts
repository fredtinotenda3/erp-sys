import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createJob, listJobs } from "../../../../src/server/modules/production/job-service";
import { JOB_STATUS_VALUES } from "../../../../src/server/modules/production/job-state";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";
import { ValidationError } from "../../../../src/server/shared/errors";

const listQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.enum(JOB_STATUS_VALUES).optional(),
  overdueOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const parsed = listQuerySchema.safeParse({
      branchId: p.get("branchId") ?? undefined,
      status: p.get("status") ?? undefined,
      overdueOnly: p.get("overdueOnly") ?? undefined,
      limit: p.get("limit") ?? undefined,
    });
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.issues);
    const jobs = await listJobs(session, {
      branchId: parsed.data.branchId,
      status: parsed.data.status,
      overdueOnly: parsed.data.overdueOnly === "true",
      limit: parsed.data.limit,
    });
    return NextResponse.json({ data: jobs });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const job = await createJob(session, body);
    return NextResponse.json({ data: job }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
