import { NextRequest, NextResponse } from "next/server";
import { updateCorrectiveAction } from "../../../../../../../src/server/modules/production/corrective-action-service";
import { requireSession } from "../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../src/server/shared/http";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, actionId } = await params;
    const body = await req.json();
    return NextResponse.json({ data: await updateCorrectiveAction(session, id, actionId, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
