import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deactivateBranch } from "../../../../../server/modules/iam/branch-service";
import { requireSession } from "../../../../../server/modules/iam/session-guard";
import { errorResponse } from "../../../../../server/shared/http";
import { ValidationError } from "../../../../../server/shared/errors";

const patchSchema = z.object({ isActive: z.literal(false) });

// Only supports isActive:false (deactivation) — there is no reactivation or
// rename endpoint in Phase 1 scope, and no hard delete at all (see
// branch-service.ts's header comment for why that's a schema-level
// constraint, not just an API design choice).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Only {"isActive": false} is supported on this endpoint', parsed.error.issues);
    }
    const branch = await deactivateBranch(session, id);
    return NextResponse.json({ data: branch });
  } catch (err) {
    return errorResponse(err);
  }
}
