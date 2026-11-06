import { NextRequest, NextResponse } from "next/server";
import { getCapacityVisibility } from "../../../../src/server/modules/production/capacity-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const sp = req.nextUrl.searchParams;
    const data = await getCapacityVisibility(session, {
      branchId: sp.get("branchId") ?? undefined,
      workCentreId: sp.get("workCentreId") ?? undefined,
      from: sp.get("from") ?? undefined,
      to: sp.get("to") ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
