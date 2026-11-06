import { NextRequest, NextResponse } from "next/server";
import { recordMachineTime, listMachineTime } from "../../../../../../src/server/modules/production/machine-time-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await listMachineTime(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// 201 for a new record, 200 for an idempotent replay of the same clientRequestId.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const result = await recordMachineTime(session, id, body);
    return NextResponse.json({ data: result.record, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
