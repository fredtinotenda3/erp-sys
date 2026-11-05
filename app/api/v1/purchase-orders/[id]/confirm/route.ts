import { NextRequest, NextResponse } from "next/server";
import { confirmPurchaseOrder } from "../../../../../../src/server/modules/purchasing/purchase-order-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await confirmPurchaseOrder(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
