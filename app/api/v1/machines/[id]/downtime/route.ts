import { NextRequest, NextResponse } from "next/server";
import { openDowntime } from "../../../../../../src/server/modules/production/machine-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const rec = await openDowntime(session, id, body);
    return NextResponse.json({ data: rec }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
