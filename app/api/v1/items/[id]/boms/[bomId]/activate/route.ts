import { NextRequest, NextResponse } from "next/server";
import { activateBomVersion } from "../../../../../../../../src/server/modules/catalog/bom-service";
import { requireSession } from "../../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; bomId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, bomId } = await params;
    const bom = await activateBomVersion(session, id, bomId);
    return NextResponse.json({ data: bom });
  } catch (err) {
    return errorResponse(err);
  }
}
