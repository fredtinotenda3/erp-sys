import { NextRequest, NextResponse } from "next/server";
import { getPlasticsProcessDetail, setPlasticsProcessDetail } from "../../../../../../../../src/server/modules/production/plastics-process-service";
import { requireSession } from "../../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../../src/server/shared/http";

// jobId ([id]) is part of the URL for routing/readability only -- the
// service looks the stage up by jobStageId alone (ProductionJobStage.id is
// globally unique) and derives branch scope from the stage's own job, same
// as every other stage-keyed sub-resource in this codebase (e.g.
// machine-time-service.ts's jobStageId-only lookups).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; stageId: string }> }) {
  try {
    const session = await requireSession(req);
    const { stageId } = await params;
    return NextResponse.json({ data: await getPlasticsProcessDetail(session, stageId) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; stageId: string }> }) {
  try {
    const session = await requireSession(req);
    const { stageId } = await params;
    const body = await req.json();
    return NextResponse.json({ data: await setPlasticsProcessDetail(session, stageId, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
