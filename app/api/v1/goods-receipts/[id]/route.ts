import { NextRequest, NextResponse } from "next/server";
import { getGoodsReceipt } from "../../../../../src/server/modules/purchasing/goods-receipt-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

// Direct lookup by receipt id -- used by traceability drill-down (a
// MaterialLot or StockMovement links back to a receipt by id, not by
// knowing which PO it belongs to).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await getGoodsReceipt(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
