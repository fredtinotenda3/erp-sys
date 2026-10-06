import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deactivateUser, updateUserRole } from "../../../../../server/modules/iam/user-service";
import { requireSession } from "../../../../../server/modules/iam/session-guard";
import { errorResponse } from "../../../../../server/shared/http";
import { ValidationError } from "../../../../../server/shared/errors";
import { ROLE_VALUES } from "../../../../../server/shared/authz";

const patchSchema = z
  .object({
    role: z.enum(ROLE_VALUES).optional(),
    isActive: z.literal(false).optional(),
  })
  .refine((d) => d.role !== undefined || d.isActive !== undefined, {
    message: "At least one of role or isActive must be provided",
  });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Invalid user update payload", parsed.error.issues);

    // Each field change goes through its own service function so each one
    // keeps its own capability check and audit entry — see
    // user-service.ts. `result` ends up holding whichever update ran last
    // when both are supplied in one request. Both return the SafeUser
    // projection (no passwordHash) already.
    let result;
    if (parsed.data.role !== undefined) {
      result = await updateUserRole(session, id, parsed.data.role);
    }
    if (parsed.data.isActive === false) {
      result = await deactivateUser(session, id);
    }

    return NextResponse.json({ data: result });
  } catch (err) {
    return errorResponse(err);
  }
}
