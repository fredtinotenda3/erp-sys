import { NextRequest, NextResponse } from "next/server";
import { getIndustryProfile, updateIndustryProfile } from "../../../../../src/server/modules/industry/industry-profile-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

// GET: every authenticated session's own org profile (no capability check
// -- see industry-profile-service.ts's header). PATCH: change it
// (industry_profile:manage, OWNER_ADMIN only -- asserted inside the service).
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    return NextResponse.json({ data: await getIndustryProfile(session) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    return NextResponse.json({ data: await updateIndustryProfile(session, body) });
  } catch (err) {
    return errorResponse(err);
  }
}
