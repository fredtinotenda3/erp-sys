import { NextRequest, NextResponse } from "next/server";
import { logout } from "../../../../../server/modules/iam/session-service";
import { SESSION_COOKIE_NAME, clearSessionCookie, errorResponse } from "../../../../../server/shared/http";

// Idempotent and tolerant of a missing/already-revoked cookie by design —
// logging out twice, or logging out with a stale/expired cookie, should
// never surface as an error to the client.
export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (token) await logout(token);

    const response = NextResponse.json({ data: { success: true } });
    clearSessionCookie(response);
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
