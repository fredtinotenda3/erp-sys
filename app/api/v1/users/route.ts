import { NextRequest, NextResponse } from "next/server";
import { createUser, listUsers } from "../../../../src/server/modules/iam/user-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const users = await listUsers(session);
    return NextResponse.json({ data: users });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    // createUser returns user-service.ts's SafeUser projection — passwordHash
    // was already excluded at the query/mapping level, not stripped here.
    const user = await createUser(session, body);
    return NextResponse.json({ data: user }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
