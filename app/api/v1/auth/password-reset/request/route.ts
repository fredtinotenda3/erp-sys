import { NextRequest, NextResponse } from "next/server";
import { requestPasswordReset } from "../../../../../../src/server/modules/iam/password-service";
import { clientIp, errorResponse } from "../../../../../../src/server/shared/http";

// Public. The answer is identical whether or not the account exists; the token is never returned.
export async function POST(req: NextRequest) {
  try {
    await requestPasswordReset(await req.json().catch(() => ({})), { ipAddress: clientIp(req.headers) });
    return NextResponse.json({ data: { message: "If that account exists, a reset link has been sent." } }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
