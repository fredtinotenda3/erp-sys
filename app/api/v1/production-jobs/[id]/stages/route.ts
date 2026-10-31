import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";
import { defineStages, listStages } from "../../../../../../src/server/modules/production/stage-service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await listStages(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// Replaces the routing (only before the job starts).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json().catch(() => null);
    return NextResponse.json({ data: await defineStages(session, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
