import { NextRequest, NextResponse } from "next/server";
import { getAvailableLotsForIssue } from "../../../../../../src/server/modules/inventory/lot-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

// The lot picker for a manual issue/return override: GET ?itemId=&warehouseId=
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const data = await getAvailableLotsForIssue(session, { itemId: p.get("itemId") ?? undefined, warehouseId: p.get("warehouseId") ?? undefined });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
