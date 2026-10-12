import { NextRequest, NextResponse } from "next/server";
import { getJobMaterials } from "../../../../../../src/server/modules/inventory/material-issue-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    return NextResponse.json({ data: await getJobMaterials(session, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
