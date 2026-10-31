import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";
import { listOutput, recordOutput } from "../../../../../../src/server/modules/production/output-service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await listOutput(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

// 201 when recorded, 200 + replayed:true on an idempotent retry.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { replayed, entry } = await recordOutput(session, id, body);
    return NextResponse.json({ data: entry, replayed }, { status: replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
