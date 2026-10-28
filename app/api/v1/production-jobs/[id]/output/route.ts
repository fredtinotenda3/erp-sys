import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "../../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../../src/server/shared/http";
import { voidOutput } from "../../../../../../../../src/server/modules/production/output-service";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; outputId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, outputId } = await params;
    const body = await req.json().catch(() => null);
    return NextResponse.json({ data: await voidOutput(session, id, outputId, body) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
