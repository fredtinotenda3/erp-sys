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
import { assertBranchAccess, assertCapability } from "../../shared/authz";
import { ValidationError } from "../../shared/errors";
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
  actorUserId?: string;
  action?: AuditAction;
  /** Inclusive lower / upper bound on createdAt. */
  from?: Date;
  to?: Date;
  /** Keyset pagination: only entries with an id LOWER than this (ids are issued in order). */
  beforeId?: bigint;
  limit?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Branch scope: OWNER_ADMIN reads everything in the organization. Anyone else sees
// organization-wide entries (no branch: users, customers, exchange rates ...) plus entries
// for branches they hold an explicit grant for -- never another branch's history.
export async function listAuditLog(session: AuthenticatedSession, filter: ListAuditLogFilter = {}) {
  assertCapability(session.role, "audit_log:read");
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);

  for (const [name, value] of [["branchId", filter.branchId], ["entityId", filter.entityId], ["actorUserId", filter.actorUserId]] as const) {
    if (value !== undefined && !UUID_RE.test(value)) throw new ValidationError(`${name} must be a valid id`);
  }
  if (filter.action !== undefined && !(AUDIT_ACTION_VALUES as readonly string[]).includes(filter.action)) {
    throw new ValidationError("Unknown audit action");
  }
  if (filter.from && filter.to && filter.from > filter.to) throw new ValidationError("The start date is after the end date");
  if (filter.branchId) assertBranchAccess(session, filter.branchId);

  const scope =
    filter.branchId || session.role === "OWNER_ADMIN"
      ? {}
      : { OR: [{ branchId: null }, { branchId: { in: [...session.branchIds] } }] };

  return prisma.auditLog.findMany({
    where: {
      orgId: session.orgId, // mandatory tenant scope — never omit this
      ...scope,
      ...(filter.branchId ? { branchId: filter.branchId } : {}),
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.actorUserId ? { actorUserId: filter.actorUserId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
      ...(filter.beforeId !== undefined ? { id: { lt: filter.beforeId } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit,
  });
}
