import { NextRequest, NextResponse } from "next/server";
import { getProfitabilityReport } from "../../../../../src/server/modules/costing/cost-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const data = await getProfitabilityReport(session, {
      from: p.get("from") ?? undefined,
      to: p.get("to") ?? undefined,
      branchId: p.get("branchId") ?? undefined,
      customerId: p.get("customerId") ?? undefined,
      productItemId: p.get("productItemId") ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
