import { NextRequest, NextResponse } from "next/server";
import { listCurrencies } from "../../../../src/server/modules/costing/currency-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    await requireSession(req);
    return NextResponse.json({ data: await listCurrencies() });
  } catch (err) {
    return errorResponse(err);
  }
}
