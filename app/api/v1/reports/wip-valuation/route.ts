import { NextRequest, NextResponse } from "next/server";
import { getWipValuation } from "../../../../../src/server/modules/inventory/finished-goods-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const jobId = req.nextUrl.searchParams.get("jobId") ?? undefined;
    return NextResponse.json({ data: await getWipValuation(session, jobId) });
  } catch (err) {
    return errorResponse(err);
  }
}
