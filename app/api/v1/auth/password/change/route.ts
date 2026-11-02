import { NextRequest, NextResponse } from "next/server";
import { changePassword } from "../../../../../../src/server/modules/iam/password-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";

// Signed-in users only. Authentication is checked BEFORE the body is read.
export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const result = await changePassword(session, await req.json().catch(() => ({})));
    return NextResponse.json({ data: result });
  } catch (err) {
    return errorResponse(err);
  }
}
