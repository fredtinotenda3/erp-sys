import { NextRequest, NextResponse } from "next/server";
import { listLots } from "../../../../../src/server/modules/inventory/lot-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
    const data = await listLots(session, {
      itemId: p.get("itemId") ?? undefined,
      warehouseId: p.get("warehouseId") ?? undefined,
      supplierId: p.get("supplierId") ?? undefined,
      status: p.get("status") ?? undefined,
      expiringBy: p.get("expiringBy") ?? undefined,
      search: p.get("search") ?? undefined,
      limit: num("limit"),
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
