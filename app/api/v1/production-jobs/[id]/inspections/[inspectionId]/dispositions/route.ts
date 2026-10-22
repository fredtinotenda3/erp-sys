import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "../../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../../src/server/shared/http";
import { recordDisposition } from "../../../../../../../../src/server/modules/production/quality-service";

// Requires quality:approve (an inspector alone cannot decide what happens to rejects).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; inspectionId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, inspectionId } = await params;
    const body = await req.json().catch(() => null);
    const result = await recordDisposition(session, id, inspectionId, body);
    return NextResponse.json({ data: result, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
