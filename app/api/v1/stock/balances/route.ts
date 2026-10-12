import { NextRequest, NextResponse } from "next/server";
import { listStockBalances } from "../../../../../src/server/modules/inventory/stock-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const data = await listStockBalances(session, {
      warehouseId: p.get("warehouseId") ?? undefined,
      itemId: p.get("itemId") ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
