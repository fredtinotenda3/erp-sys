import { NextRequest, NextResponse } from "next/server";
import { createRegrindLot } from "../../../../../../src/server/modules/inventory/regrind-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

// Note: createRegrindLot's own payload carries sourceJobId -- [id] here is
// the job the regrind call is made FROM in the UI (job-detail page), and is
// cross-checked against the body's sourceJobId to catch a stale page
// posting against the wrong job after navigation.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = (await req.json()) as Record<string, unknown>;
    if (body.sourceJobId !== undefined && body.sourceJobId !== id) {
      return NextResponse.json({ error: { message: "sourceJobId does not match the job in the URL" } }, { status: 400 });
    }
    const result = await createRegrindLot(session, { ...body, sourceJobId: id });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
