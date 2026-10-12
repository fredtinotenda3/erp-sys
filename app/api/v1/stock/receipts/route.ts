import { NextRequest, NextResponse } from "next/server";
import { receiveStock } from "../../../../../src/server/modules/inventory/stock-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

// 201 for a new movement, 200 for an idempotent replay of the same clientRequestId.
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const result = await receiveStock(session, body);
    return NextResponse.json({ data: result.movement, balance: result.balance, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
