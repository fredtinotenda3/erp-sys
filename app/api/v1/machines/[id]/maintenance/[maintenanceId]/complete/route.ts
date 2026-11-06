import { NextRequest, NextResponse } from "next/server";
import { completeMaintenance } from "../../../../../../../../src/server/modules/production/machine-service";
import { requireSession } from "../../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../../src/server/shared/http";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; maintenanceId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, maintenanceId } = await params;
    const body = await req.json().catch(() => ({}));
    const rec = await completeMaintenance(session, id, maintenanceId, body);
    return NextResponse.json({ data: rec });
  } catch (err) {
    return errorResponse(err);
  }
}
