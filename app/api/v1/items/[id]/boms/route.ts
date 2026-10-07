import { NextRequest, NextResponse } from "next/server";
import { createBomVersion, listBomVersions } from "../../../../../../src/server/modules/catalog/bom-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const boms = await listBomVersions(session, id);
    return NextResponse.json({ data: boms });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const bom = await createBomVersion(session, id, body);
    return NextResponse.json({ data: bom }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
