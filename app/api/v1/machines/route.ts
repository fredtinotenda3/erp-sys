import { NextRequest, NextResponse } from "next/server";
import { createMachine, listMachines } from "../../../../src/server/modules/production/machine-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const sp = req.nextUrl.searchParams;
    const data = await listMachines(session, {
      workCentreId: sp.get("workCentreId") ?? undefined,
      branchId: sp.get("branchId") ?? undefined,
      status: (sp.get("status") as "available" | "in_use" | "down" | "maintenance" | "retired" | null) ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const m = await createMachine(session, body);
    return NextResponse.json({ data: m }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
