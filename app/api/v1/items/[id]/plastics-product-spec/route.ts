import { NextRequest, NextResponse } from "next/server";
import { getPlasticsProductSpec, setPlasticsProductSpec } from "../../../../../../src/server/modules/catalog/plastics-item-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await getPlasticsProductSpec(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    return NextResponse.json({ data: await setPlasticsProductSpec(session, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
