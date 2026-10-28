import { NextRequest, NextResponse } from "next/server";
import { getSalesOrder, updateSalesOrder } from "../../../../../src/server/modules/sales/sales-order-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await getSalesOrder(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// Draft orders only; the service rejects edits to anything else with 409.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await updateSalesOrder(session, id, await req.json()) });
  } catch (err) {
    return errorResponse(err);
  }
}
