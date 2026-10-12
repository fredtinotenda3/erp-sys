import { NextRequest, NextResponse } from "next/server";
import { createWarehouse, listWarehouses } from "../../../../src/server/modules/inventory/warehouse-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    return NextResponse.json({ data: await listWarehouses(session) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    return NextResponse.json({ data: await createWarehouse(session, body) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
