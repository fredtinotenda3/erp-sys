import { NextRequest, NextResponse } from "next/server";
import { getJobLotConsumption } from "../../../../../../src/server/modules/inventory/lot-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

// Per-material lot breakdown for this job -- the lot-level detail behind
// the expected-vs-issued figures GET .../materials already returns.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await getJobLotConsumption(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
