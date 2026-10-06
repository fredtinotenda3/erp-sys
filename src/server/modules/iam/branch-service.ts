// Branch CRUD-lite and branch-access grant/revoke. Deliberately NO hard
// delete: once a branch exists it is almost certainly referenced by an
// audit_log row (every create/grant action against it is audited), and
// audit_log.branch_id -> branch(org_id, id) has no ON DELETE CASCADE in
// schema.sql (by design — an audit trail must outlive the entities it
// describes). A DELETE would simply fail with a foreign-key violation once
// any audit history exists, which in practice is immediately. `isActive`
// (soft delete) is the only lifecycle transition this module exposes.
import { z } from "zod";
import { prisma, isUniqueConstraintError } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "./audit-service";
import type { AuthenticatedSession } from "./session-service";

const createBranchSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export async function createBranch(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "branch:create");
  const parsed = createBranchSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid branch payload", parsed.error.issues);

  try {
    const branch = await prisma.branch.create({
      data: { orgId: session.orgId, name: parsed.data.name },
    });
    await recordAudit(prisma, {
      orgId: session.orgId,
      branchId: branch.id,
      actorUserId: session.userId,
      entityType: "branch",
      entityId: branch.id,
      action: "create",
      afterValue: { name: branch.name },
    });
    return branch;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(`A branch named "${parsed.data.name}" already exists in this organization`);
    }
    throw err;
  }
}

// OWNER_ADMIN sees every branch in the org (implicit all-branch access).
// Every other role sees only branches it holds an explicit grant for — this
// is the read-path expression of the exact same rule
// shared/authz.ts#hasBranchAccess enforces for write-path checks, and it is
// the core assertion of the branch-isolation test suite.
export async function listBranches(session: AuthenticatedSession) {
  assertCapability(session.role, "branch:read");

  if (session.role === "OWNER_ADMIN") {
    return prisma.branch.findMany({ where: { orgId: session.orgId }, orderBy: { name: "asc" } });
  }

  return prisma.branch.findMany({
    where: { orgId: session.orgId, userAccess: { some: { userId: session.userId } } },
    orderBy: { name: "asc" },
  });
}

export async function deactivateBranch(session: AuthenticatedSession, branchId: string) {
  assertCapability(session.role, "branch:deactivate");

  // Tenant-ownership check BEFORE any mutation: fetch scoped by orgId first,
  // then act on the confirmed row's bare id. Never update-by-bare-id
  // without this step — see shared/scope.ts's header comment.
  const branch = await prisma.branch.findFirst({ where: { orgId: session.orgId, id: branchId } });
  if (!branch) throw new NotFoundError("Branch");
  if (!branch.isActive) return branch;

  const updated = await prisma.branch.update({ where: { id: branch.id }, data: { isActive: false } });
  await recordAudit(prisma, {
    orgId: session.orgId,
    branchId: branch.id,
    actorUserId: session.userId,
    entityType: "branch",
    entityId: branch.id,
    action: "update",
    beforeValue: { isActive: true },
    afterValue: { isActive: false },
  });
  return updated;
}

export interface BranchAccessInput {
  userId: string;
  branchId: string;
}

export async function grantBranchAccess(session: AuthenticatedSession, input: BranchAccessInput) {
  assertCapability(session.role, "branch_access:grant");

  const [branch, user] = await Promise.all([
    prisma.branch.findFirst({ where: { orgId: session.orgId, id: input.branchId } }),
    prisma.user.findFirst({ where: { orgId: session.orgId, id: input.userId } }),
  ]);
  if (!branch) throw new NotFoundError("Branch");
  if (!user) throw new NotFoundError("User");

  try {
    await prisma.userBranchAccess.create({
      data: { orgId: session.orgId, userId: user.id, branchId: branch.id, grantedBy: session.userId },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) return; // already granted — idempotent, not an error
    throw err;
  }

  await recordAudit(prisma, {
    orgId: session.orgId,
    branchId: branch.id,
    actorUserId: session.userId,
    entityType: "user_branch_access",
    entityId: user.id,
    action: "grant",
    afterValue: { branchId: branch.id, userId: user.id },
  });
}

export async function revokeBranchAccess(session: AuthenticatedSession, input: BranchAccessInput): Promise<boolean> {
  assertCapability(session.role, "branch_access:revoke");

  const result = await prisma.userBranchAccess.deleteMany({
    where: { orgId: session.orgId, branchId: input.branchId, userId: input.userId },
  });
  if (result.count === 0) return false;

  await recordAudit(prisma, {
    orgId: session.orgId,
    branchId: input.branchId,
    actorUserId: session.userId,
    entityType: "user_branch_access",
    entityId: input.userId,
    action: "revoke",
    beforeValue: { branchId: input.branchId, userId: input.userId },
  });
  return true;
}
