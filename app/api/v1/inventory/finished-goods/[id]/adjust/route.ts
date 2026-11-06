import { NextRequest, NextResponse } from "next/server";
import { adjustBatch } from "../../../../../../../src/server/modules/inventory/finished-goods-service";
import { requireSession } from "../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const result = await adjustBatch(session, id, body);
    return NextResponse.json({ data: { remaining: result.remaining }, replayed: result.replayed }, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
