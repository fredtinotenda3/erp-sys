import { NextRequest, NextResponse } from "next/server";
import { listStockMovements } from "../../../../../src/server/modules/inventory/stock-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const limit = p.get("limit");
    const data = await listStockMovements(session, {
      itemId: p.get("itemId") ?? undefined,
      warehouseId: p.get("warehouseId") ?? undefined,
      referenceId: p.get("referenceId") ?? undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
