import { NextRequest, NextResponse } from "next/server";
import { recordCostAdjustment } from "../../../../../../src/server/modules/costing/cost-adjustment-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

// Corrections to a frozen job cost. 201 when recorded, 200 + replayed:true on an
// idempotent retry (same clientRequestId, same payload).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { replayed, adjustment } = await recordCostAdjustment(session, id, body);
    return NextResponse.json({ data: adjustment, replayed }, { status: replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
