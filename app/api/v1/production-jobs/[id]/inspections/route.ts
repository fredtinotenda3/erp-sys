import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";
import { listInspections, recordInspection } from "../../../../../../src/server/modules/production/quality-service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await listInspections(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { replayed, inspection } = await recordInspection(session, id, body);
    return NextResponse.json({ data: inspection, replayed }, { status: replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
