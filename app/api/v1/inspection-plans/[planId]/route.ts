import { NextRequest, NextResponse } from "next/server";
import { getInspectionPlan, updateInspectionPlan } from "../../../../../src/server/modules/production/quality-plan-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ planId: string }> }) {
  try {
    const session = await requireSession(req);
    const { planId } = await params;
    return NextResponse.json({ data: await getInspectionPlan(session, planId) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ planId: string }> }) {
  try {
    const session = await requireSession(req);
    const { planId } = await params;
    const body = await req.json();
    return NextResponse.json({ data: await updateInspectionPlan(session, planId, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
