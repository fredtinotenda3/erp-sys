import { NextRequest, NextResponse } from "next/server";
import { listIndustryProfiles } from "../../../../../src/server/modules/industry/industry-profile-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

// The static profile registry (every profile, its label/description,
// whether it has any implemented modules, and what those modules are) --
// not org-specific, no capability check (same as the Currency/UOM reference
// lookups elsewhere in this codebase): this is the admin screen's profile
// picker data, not a privileged read. Still requires an authenticated
// session (not a public endpoint).
export async function GET(req: NextRequest) {
  try {
    await requireSession(req);
    return NextResponse.json({ data: listIndustryProfiles() });
  } catch (err) {
    return errorResponse(err);
  }
}
