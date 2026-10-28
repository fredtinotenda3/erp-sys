import { NextRequest, NextResponse } from "next/server";
import { listAuditLog, type AuditAction } from "../../../../src/server/modules/iam/audit-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";
import { ValidationError } from "../../../../src/server/shared/errors";

function parseDate(v: string | null, name: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${name} is not a valid date`);
  return d;
}

function parseCursor(v: string | null): bigint | undefined {
  if (!v) return undefined;
  if (!/^\d{1,18}$/.test(v)) throw new ValidationError("beforeId must be a whole number");
  return BigInt(v);
}

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const params = new URL(req.url).searchParams;
    const limitParam = params.get("limit");

    const entries = await listAuditLog(session, {
      branchId: params.get("branchId") ?? undefined,
      entityType: params.get("entityType") ?? undefined,
      entityId: params.get("entityId") ?? undefined,
      actorUserId: params.get("actorUserId") ?? undefined,
      action: (params.get("action") as AuditAction | null) ?? undefined,
      from: parseDate(params.get("from"), "from"),
      to: parseDate(params.get("to"), "to"),
      beforeId: parseCursor(params.get("beforeId")),
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
