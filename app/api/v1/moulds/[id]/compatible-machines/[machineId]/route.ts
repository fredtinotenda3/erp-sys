import { NextRequest, NextResponse } from "next/server";
import { removeMouldMachineCompatibility } from "../../../../../../../src/server/modules/production/mould-service";
import { requireSession } from "../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../src/server/shared/http";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; machineId: string }> }) {
  try {
    const session = await requireSession(req);
    const { id, machineId } = await params;
    await removeMouldMachineCompatibility(session, id, machineId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
