import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserDisplay } from "../../../../../src/server/modules/iam/me-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { capabilitiesFor } from "../../../../../src/server/shared/authz";
import { errorResponse } from "../../../../../src/server/shared/http";

// "Who am I" for client code: identity, role, branches, and the capability list
// the UI uses to decide what to show. The server still re-checks every action.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const user = await getCurrentUserDisplay(session);
    return NextResponse.json({ data: { ...user, role: session.role, capabilities: capabilitiesFor(session.role) } });
  } catch (err) {
    return errorResponse(err);
  }
}
