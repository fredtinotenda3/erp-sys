import { NextRequest, NextResponse } from "next/server";
import { login } from "../../../../../server/modules/iam/session-service";
import { setSessionCookie, errorResponse } from "../../../../../server/shared/http";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const userAgent = req.headers.get("user-agent") ?? undefined;

    const { token, expiresAt, session } = await login(body, { ipAddress, userAgent });

    const response = NextResponse.json(
      { data: { userId: session.userId, orgId: session.orgId, role: session.role } },
      { status: 200 },
    );
    setSessionCookie(response, token, expiresAt);
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}
