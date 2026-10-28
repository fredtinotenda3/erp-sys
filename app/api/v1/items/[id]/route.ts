import { NextRequest, NextResponse } from "next/server";
import { getActiveBom } from "../../../../../../../src/server/modules/catalog/bom-service";
import { requireSession } from "../../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../../src/server/shared/http";

// Returns { data: null } with 200, not 404, when the item has no active BOM
// yet — see bom-service.ts's getActiveBom header comment. A 404 here would
// make "no active BOM" indistinguishable from "this item doesn't exist,"
// which the frontend needs to tell apart (UX_UI_ARCHITECTURE.md §2.6).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const bom = await getActiveBom(session, id);
    return NextResponse.json({ data: bom });
  } catch (err) {
    return errorResponse(err);
  }
}
