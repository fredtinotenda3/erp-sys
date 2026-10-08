import { NextRequest, NextResponse } from "next/server";
import { transitionJob } from "../../../../../../src/server/modules/production/job-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    return NextResponse.json({ data: await transitionJob(session, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
