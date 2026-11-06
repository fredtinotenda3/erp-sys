import { NextRequest, NextResponse } from "next/server";
import { addCharacteristic } from "../../../../../../src/server/modules/production/quality-plan-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ planId: string }> }) {
  try {
    const session = await requireSession(req);
    const { planId } = await params;
    const body = await req.json();
    const c = await addCharacteristic(session, planId, body);
    return NextResponse.json({ data: c }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
