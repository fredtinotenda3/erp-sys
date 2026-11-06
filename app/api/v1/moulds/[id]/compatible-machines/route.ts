import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { addMouldMachineCompatibility } from "../../../../../../src/server/modules/production/mould-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";
import { ValidationError } from "../../../../../../src/server/shared/errors";

const bodySchema = z.object({ machineId: z.string().uuid() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) throw new ValidationError("machineId is required", parsed.error.issues);
    const row = await addMouldMachineCompatibility(session, id, parsed.data.machineId);
    return NextResponse.json({ data: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
