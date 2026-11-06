import { NextRequest, NextResponse } from "next/server";
import { listDispatches } from "../../../../src/server/modules/inventory/dispatch-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
    const status = p.get("status");
    const data = await listDispatches(session, {
      salesOrderId: p.get("salesOrderId") ?? undefined,
      warehouseId: p.get("warehouseId") ?? undefined,
      status: status === "dispatched" || status === "delivered" ? status : undefined,
      search: p.get("search") ?? undefined,
      limit: num("limit"),
      offset: num("offset"),
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
