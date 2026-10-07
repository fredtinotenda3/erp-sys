import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { grantBranchAccess, revokeBranchAccess } from "../../../../../../src/server/modules/iam/branch-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";
import { NotFoundError, ValidationError } from "../../../../../../src/server/shared/errors";

const grantSchema = z.object({ branchId: z.string().uuid() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const parsed = grantSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("branchId is required", parsed.error.issues);

    await grantBranchAccess(session, { userId: id, branchId: parsed.data.branchId });
    return NextResponse.json({ data: { success: true } }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const branchId = new URL(req.url).searchParams.get("branchId");
    if (!branchId) throw new ValidationError("branchId query parameter is required");

    const revoked = await revokeBranchAccess(session, { userId: id, branchId });
    if (!revoked) throw new NotFoundError("Branch access grant");
    return NextResponse.json({ data: { success: true } });
  } catch (err) {
    return errorResponse(err);
  }
}
