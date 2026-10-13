import { NextRequest, NextResponse } from "next/server";
import { listJobCosts } from "../../../../../src/server/modules/costing/cost-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const limit = p.get("limit");
    const data = await listJobCosts(session, {
      branchId: p.get("branchId") ?? undefined,
      status: p.get("status") ?? undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
