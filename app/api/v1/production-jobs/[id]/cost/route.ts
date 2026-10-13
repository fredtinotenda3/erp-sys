import { NextRequest, NextResponse } from "next/server";
import { getJobCost } from "../../../../../../src/server/modules/costing/cost-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

// ?convertTo=USD&rateSource=MANUAL is optional; without it figures stay grouped by currency.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const p = req.nextUrl.searchParams;
    const data = await getJobCost(session, id, {
      convertTo: p.get("convertTo") ?? undefined,
      rateSource: p.get("rateSource") ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
