import { NextRequest, NextResponse } from "next/server";
import { confirmPasswordReset } from "../../../../../../src/server/modules/iam/password-service";
import { clientIp, errorResponse } from "../../../../../../src/server/shared/http";

// Public by nature: the one-time token IS the credential.
export async function POST(req: NextRequest) {
  try {
    await confirmPasswordReset(await req.json().catch(() => ({})), { ipAddress: clientIp(req.headers) });
    return NextResponse.json({ data: { message: "Password updated. Sign in with your new password." } });
  } catch (err) {
    return errorResponse(err);
  }
}
