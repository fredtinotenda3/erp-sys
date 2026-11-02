import { NextRequest, NextResponse } from "next/server";
import { bootstrapOrganization } from "../../../../../src/server/modules/iam/org-service";
import { assertBootstrapAllowed } from "../../../../../src/server/modules/iam/bootstrap-gate";
import { errorResponse } from "../../../../../src/server/shared/http";

// Unauthenticated by necessity (there is no user yet), so it is gated instead: disabled in production
// unless ORG_BOOTSTRAP_TOKEN is set and presented as `x-bootstrap-token`; always rate limited.
// See src/server/modules/iam/bootstrap-gate.ts.
export async function POST(req: NextRequest) {
  try {
    await assertBootstrapAllowed(req.headers);
    const body = await req.json();
    const result = await bootstrapOrganization(body);
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
