// Append-only audit trail. `recordAudit` is an internal helper — it is NOT
// exposed through a route and does NOT assert a capability itself, because
// every caller is another server/modules/* service function that has
// already authorized the action being recorded (recording the audit entry
// is a side effect of that already-authorized write, not a new privileged
// operation of its own). `listAuditLog` IS exposed through a route
// (app/api/v1/audit-log) and does assert its own capability, following the
// same pattern as every other *read* entry point in this module.
//
// action values are a plain string-literal union here rather than the
// generated Prisma `AuditAction` enum for the same reason roles are
// redeclared in shared/authz.ts — see that file's header comment. Confirm
// these 6 values still match prisma/schema.prisma's `enum AuditAction`
// after your first successful `prisma generate`.
// See shared/db.ts's import comment re: the "/client" suffix.
import type { Prisma } from "../../../generated/prisma/client";
import { prisma, type Db } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import type { AuthenticatedSession } from "./session-service";

export const AUDIT_ACTION_VALUES = ["create", "update", "delete", "transition", "grant", "revoke"] as const;
export type AuditAction = (typeof AUDIT_ACTION_VALUES)[number];

export interface RecordAuditInput {
  orgId: string;
  branchId?: string | null;
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: AuditAction;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string | null;
}

export async function recordAudit(db: Db, input: RecordAuditInput) {
  return db.auditLog.create({
    data: {
      orgId: input.orgId,
      branchId: input.branchId ?? null,
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeValue: input.beforeValue === undefined ? undefined : (input.beforeValue as Prisma.InputJsonValue),
      afterValue: input.afterValue === undefined ? undefined : (input.afterValue as Prisma.InputJsonValue),
      reason: input.reason ?? null,
    },
  });
}

export interface ListAuditLogFilter {
  branchId?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
}

export async function listAuditLog(session: AuthenticatedSession, filter: ListAuditLogFilter = {}) {
  assertCapability(session.role, "audit_log:read");
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

  return prisma.auditLog.findMany({
    where: {
      orgId: session.orgId, // mandatory tenant scope — never omit this
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
