import { NextRequest, NextResponse } from "next/server";
import { createPurchaseOrder, listPurchaseOrders, type PurchaseOrderStatus } from "../../../../src/server/modules/purchasing/purchase-order-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
    const data = await listPurchaseOrders(session, {
      status: (p.get("status") as PurchaseOrderStatus | null) ?? undefined,
      supplierId: p.get("supplierId") ?? undefined,
      branchId: p.get("branchId") ?? undefined,
      search: p.get("search") ?? undefined,
      limit: num("limit"),
      offset: num("offset"),
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const order = await createPurchaseOrder(session, await req.json());
    return NextResponse.json({ data: order }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
