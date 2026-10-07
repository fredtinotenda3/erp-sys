import { NextRequest, NextResponse } from "next/server";
import { createBranch, listBranches } from "../../../../src/server/modules/iam/branch-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const branches = await listBranches(session);
    return NextResponse.json({ data: branches });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const branch = await createBranch(session, body);
    return NextResponse.json({ data: branch }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
