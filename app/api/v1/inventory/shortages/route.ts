import { NextRequest, NextResponse } from "next/server";
import { getShortages } from "../../../../../src/server/modules/inventory/shortage-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const data = await getShortages(session, {
      branchId: p.get("branchId") ?? undefined,
      status: p.get("status") ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
