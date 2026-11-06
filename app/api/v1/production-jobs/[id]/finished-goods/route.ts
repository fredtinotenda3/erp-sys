import { NextRequest, NextResponse } from "next/server";
import { getJobFinishedGoodsSummary, receiveFinishedGoods } from "../../../../../../src/server/modules/inventory/finished-goods-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await getJobFinishedGoodsSummary(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// 201 for a new receipt, 200 for an idempotent replay of the same clientRequestId.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const result = await receiveFinishedGoods(session, id, body);
    return NextResponse.json({ data: result.batch, movement: result.movement, balance: result.balance, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
