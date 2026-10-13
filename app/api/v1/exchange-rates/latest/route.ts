import { NextRequest, NextResponse } from "next/server";
import { getLatestExchangeRate } from "../../../../../src/server/modules/costing/exchange-rate-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const data = await getLatestExchangeRate(session, {
      baseCurrency: p.get("baseCurrency") ?? undefined,
      quoteCurrency: p.get("quoteCurrency") ?? undefined,
      source: p.get("source") ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}
