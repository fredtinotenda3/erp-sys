// User CRUD-lite. Like branches, no hard delete — audit_log.actor_user_id
// references app_user with no cascade, so a user who has ever acted (every
// login is audited) cannot be deleted at the DB level either. `isActive`
// (soft delete) plus immediate session revocation is the exposed lifecycle
// transition.
import { z } from "zod";
import { prisma, isUniqueConstraintError, type Db } from "../../shared/db";
import { assertCapability, ROLE_VALUES, type Role } from "../../shared/authz";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../shared/errors";
import { hashPassword } from "../../shared/password";
import { recordAudit } from "./audit-service";
import { revokeAllSessionsForUser } from "./session-service";
import type { AuthenticatedSession } from "./session-service";

const roleSchema = z.enum(ROLE_VALUES);

// Every function in this module that returns a user returns THIS shape —
// never the raw Prisma row. Stripping passwordHash here, once, means no
// route handler needs to remember to do it on every call site; a route that
// forgot would otherwise leak an argon2 hash into an HTTP response body.
export interface SafeUser {
  id: string;
  orgId: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SAFE_USER_SELECT = {
  id: true,
  orgId: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toSafeUser(user: {
  id: string;
  orgId: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): SafeUser {
  return {
    id: user.id,
    orgId: user.orgId,
    email: user.email,
    fullName: user.fullName,
    role: user.role as Role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1).max(200),
  role: roleSchema,
  password: z.string().min(12).max(200),
  // Branches to grant explicit access to immediately. Ignored/unnecessary
  // for an OWNER_ADMIN (implicit all-branch access) but not rejected if
  // supplied — simplest contract for the caller.
  branchIds: z.array(z.string().uuid()).max(100).default([]),
});

// The only privilege-escalation guard specific to CREATE (assertCapability
// already keeps non-admin roles out of user:create entirely; this extra
// check stops an OPERATIONS_MANAGER, who DOES have user:create, from
// minting a brand new OWNER_ADMIN).
function assertCanAssignRole(actorRole: Role, targetRole: Role): void {
  if (targetRole === "OWNER_ADMIN" && actorRole !== "OWNER_ADMIN") {
    throw new ForbiddenError("Only an OWNER_ADMIN can assign the OWNER_ADMIN role");
  }
}

// Known limitation: this check-then-act is not race-proof against two
// concurrent requests simultaneously demoting/deactivating the two
// remaining OWNER_ADMINs of an org (each request's count() would see the
// other as still active). That window is narrow and the failure mode is
// "an org is left with zero admins," which is bad but recoverable (restore
// from an audit_log entry + direct DB fix) rather than a security hole — not
// worth a SERIALIZABLE transaction or advisory lock for a Phase 1 IAM
// skeleton. Revisit if usage patterns make concurrent admin changes likely.
async function assertNotLastActiveOwnerAdmin(db: Db, orgId: string, excludingUserId: string): Promise<void> {
  const remaining = await db.user.count({
    where: { orgId, role: "OWNER_ADMIN", isActive: true, id: { not: excludingUserId } },
  });
  if (remaining === 0) {
    throw new ConflictError("Cannot remove the last active OWNER_ADMIN from an organization");
  }
}

export async function createUser(session: AuthenticatedSession, input: unknown): Promise<SafeUser> {
  assertCapability(session.role, "user:create");
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid user payload", parsed.error.issues);
  const data = parsed.data;

  assertCanAssignRole(session.role, data.role);

  // Deduplicate before validating/inserting — a repeated branchId in the
  // input must never reach userBranchAccess.createMany (its (org_id,
  // user_id, branch_id) composite PK would reject the second copy as a
  // P2002, which the catch block below would otherwise misreport as an
  // email collision).
  const branchIds = [...new Set(data.branchIds)];

  if (branchIds.length > 0) {
    const validBranches = await prisma.branch.findMany({
      where: { orgId: session.orgId, id: { in: branchIds } },
      select: { id: true },
    });
    if (validBranches.length !== branchIds.length) {
      throw new ValidationError("One or more branchIds do not belong to this organization");
    }
  }

  const passwordHash = await hashPassword(data.password);

  try {
    const createdUser = await prisma.$transaction(async (tx) => {
      const createdInTx = await tx.user.create({
        data: { orgId: session.orgId, email: data.email, fullName: data.fullName, role: data.role, passwordHash },
      });

      if (branchIds.length > 0) {
        await tx.userBranchAccess.createMany({
          data: branchIds.map((branchId) => ({
            orgId: session.orgId,
            userId: createdInTx.id,
            branchId,
            grantedBy: session.userId,
          })),
        });
      }

      await recordAudit(tx, {
        orgId: session.orgId,
        actorUserId: session.userId,
        entityType: "app_user",
        entityId: createdInTx.id,
        action: "create",
        afterValue: { email: createdInTx.email, role: createdInTx.role },
      });
      if (branchIds.length > 0) {
        await recordAudit(tx, {
          orgId: session.orgId,
          actorUserId: session.userId,
          entityType: "user_branch_access",
          entityId: createdInTx.id,
          action: "grant",
          afterValue: { branchIds },
        });
      }

      return createdInTx;
    });

    return toSafeUser(createdUser);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(`A user with email "${data.email}" already exists in this organization`);
    }
    throw err;
  }
}

// SAFE_USER_SELECT already excludes passwordHash at the query level — this
// is the only list/read path for user rows and it must be impossible to
// accidentally leak a hash through it.
export async function listUsers(session: AuthenticatedSession): Promise<SafeUser[]> {
  assertCapability(session.role, "user:read");
  const rows = await prisma.user.findMany({
    where: { orgId: session.orgId },
    select: SAFE_USER_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toSafeUser);
}

export async function updateUserRole(
  session: AuthenticatedSession,
  targetUserId: string,
  newRole: unknown,
): Promise<SafeUser> {
  assertCapability(session.role, "user:update_role"); // Phase 1 default: OWNER_ADMIN only (shared/authz.ts)
  const parsedRole = roleSchema.safeParse(newRole);
  if (!parsedRole.success) throw new ValidationError("Invalid role", parsedRole.error.issues);

  assertCanAssignRole(session.role, parsedRole.data);

  const target = await prisma.user.findFirst({ where: { orgId: session.orgId, id: targetUserId } });
  if (!target) throw new NotFoundError("User");

  if (target.role === "OWNER_ADMIN" && parsedRole.data !== "OWNER_ADMIN") {
    await assertNotLastActiveOwnerAdmin(prisma, session.orgId, target.id);
  }

  const updated = await prisma.user.update({ where: { id: target.id }, data: { role: parsedRole.data } });
  await recordAudit(prisma, {
    orgId: session.orgId,
    actorUserId: session.userId,
    entityType: "app_user",
    entityId: target.id,
    action: "update",
    beforeValue: { role: target.role },
    afterValue: { role: updated.role },
  });
  return toSafeUser(updated);
}

export async function deactivateUser(session: AuthenticatedSession, targetUserId: string): Promise<SafeUser> {
  assertCapability(session.role, "user:deactivate");

  const target = await prisma.user.findFirst({ where: { orgId: session.orgId, id: targetUserId } });
  if (!target) throw new NotFoundError("User");
  if (!target.isActive) return toSafeUser(target);

  if (target.role === "OWNER_ADMIN") {
    await assertNotLastActiveOwnerAdmin(prisma, session.orgId, target.id);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedInTx = await tx.user.update({ where: { id: target.id }, data: { isActive: false } });
    await recordAudit(tx, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "app_user",
      entityId: target.id,
      action: "update",
      beforeValue: { isActive: true },
      afterValue: { isActive: false },
      reason: "deactivated",
    });
    // Instant revocability: a deactivated user's existing sessions must stop
    // working immediately, not linger until their natural expiry.
    await revokeAllSessionsForUser(tx, session.orgId, target.id);
    return updatedInTx;
  });

  return toSafeUser(updated);
}
