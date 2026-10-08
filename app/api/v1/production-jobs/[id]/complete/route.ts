import { NextRequest, NextResponse } from "next/server";
import { completeJob } from "../../../../../../src/server/modules/production/job-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await completeJob(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
