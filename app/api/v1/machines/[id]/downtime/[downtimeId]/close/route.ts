import { NextRequest, NextResponse } from "next/server";
import { closeDowntime } from "../../../../../../../../src/server/modules/production/machine-service";
import { requireSession } from "../../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; downtimeId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, downtimeId } = await params;
    const body = await req.json().catch(() => ({}));
    const rec = await closeDowntime(session, id, downtimeId, body);
    return NextResponse.json({ data: rec });
  } catch (err) {
    return errorResponse(err);
  }
}
