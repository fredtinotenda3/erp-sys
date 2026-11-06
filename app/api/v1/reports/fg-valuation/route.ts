import { NextRequest, NextResponse } from "next/server";
import { getFinishedGoodsValuation } from "../../../../../src/server/modules/inventory/finished-goods-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    return NextResponse.json({ data: await getFinishedGoodsValuation(session) });
  } catch (err) {
    return errorResponse(err);
  }
}
