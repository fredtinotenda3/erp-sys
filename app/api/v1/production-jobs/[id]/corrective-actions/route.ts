import { NextRequest, NextResponse } from "next/server";
import { createCorrectiveAction, listCorrectiveActions } from "../../../../../../src/server/modules/production/corrective-action-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await listCorrectiveActions(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const row = await createCorrectiveAction(session, id, body);
    return NextResponse.json({ data: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
