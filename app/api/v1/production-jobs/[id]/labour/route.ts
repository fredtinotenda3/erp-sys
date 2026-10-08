import { NextRequest, NextResponse } from "next/server";
import { recordLabour } from "../../../../../../src/server/modules/production/labour-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

// 201 for a new record, 200 for an idempotent replay of the same clientRequestId.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const result = await recordLabour(session, id, body);
    return NextResponse.json({ data: result.record, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
