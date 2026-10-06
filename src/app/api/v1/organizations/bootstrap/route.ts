import { NextRequest, NextResponse } from "next/server";
import { bootstrapOrganization } from "../../../../../server/modules/iam/org-service";
import { errorResponse } from "../../../../../server/shared/http";

// Unauthenticated by necessity — see org-service.ts's header comment for
// the production-deployment caveat (gate behind an invite code if
// self-service tenant creation isn't desired).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = await bootstrapOrganization(body);
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
