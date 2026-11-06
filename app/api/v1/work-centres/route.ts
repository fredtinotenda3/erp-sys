import { NextRequest, NextResponse } from "next/server";
import { createWorkCentre, listWorkCentres } from "../../../../src/server/modules/production/machine-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const branchId = req.nextUrl.searchParams.get("branchId") ?? undefined;
    return NextResponse.json({ data: await listWorkCentres(session, { branchId }) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const wc = await createWorkCentre(session, body);
    return NextResponse.json({ data: wc }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
