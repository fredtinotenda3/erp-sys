import { NextRequest, NextResponse } from "next/server";
import { getMould, updateMould } from "../../../../../src/server/modules/production/mould-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await getMould(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    return NextResponse.json({ data: await updateMould(session, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
