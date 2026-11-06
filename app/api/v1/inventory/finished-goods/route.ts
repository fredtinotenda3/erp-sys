import { NextRequest, NextResponse } from "next/server";
import { listFinishedGoodsBatches } from "../../../../../src/server/modules/inventory/finished-goods-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const limit = p.get("limit");
    const data = await listFinishedGoodsBatches(session, {
      productItemId: p.get("productItemId") ?? undefined,
      warehouseId: p.get("warehouseId") ?? undefined,
      jobId: p.get("jobId") ?? undefined,
      status: p.get("status") ?? undefined,
      search: p.get("search") ?? undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
