import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "../../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../../src/server/shared/http";
import { transitionStage } from "../../../../../../../../src/server/modules/production/stage-service";

// { action: "start" | "complete" | "block" | "unblock", reason?, notes? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; stageId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, stageId } = await params;
    const body = await req.json().catch(() => null);
    return NextResponse.json({ data: await transitionStage(session, id, stageId, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
