import { NextRequest, NextResponse } from "next/server";
import { createDispatch, listDispatchesForOrder } from "../../../../../../src/server/modules/inventory/dispatch-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await listDispatchesForOrder(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// 201 for a new dispatch, 200 for an idempotent replay of the same clientRequestId.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const result = await createDispatch(session, id, body);
    return NextResponse.json({ data: result.dispatch, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
