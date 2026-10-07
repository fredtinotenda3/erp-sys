import { NextRequest, NextResponse } from "next/server";
import { listAuditLog } from "../../../../src/server/modules/iam/audit-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const params = new URL(req.url).searchParams;
    const limitParam = params.get("limit");

    const entries = await listAuditLog(session, {
      branchId: params.get("branchId") ?? undefined,
      entityType: params.get("entityType") ?? undefined,
      entityId: params.get("entityId") ?? undefined,
      limit: limitParam ? Number(limitParam) : undefined,
    });

    // audit_log.id is a Postgres bigserial -> Prisma BigInt, and
    // JSON.stringify (which NextResponse.json uses internally) throws a
    // TypeError on a raw BigInt. Serialize it to a decimal string, the
    // standard JSON-safe representation for 64-bit integers — the client
    // must not attempt arithmetic on it (it's an opaque cursor/identifier).
    const serialized = entries.map((entry) => ({ ...entry, id: entry.id.toString() }));
    return NextResponse.json({ data: serialized });
  } catch (err) {
    return errorResponse(err);
  }
}
