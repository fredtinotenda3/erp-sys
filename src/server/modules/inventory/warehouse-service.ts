import { z } from "zod";
import { prisma, isUniqueConstraintError } from "../../shared/db";
import { assertCapability, assertBranchAccess, hasBranchAccess } from "../../shared/authz";
import { ConflictError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

const createSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
});

export async function createWarehouse(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "warehouse:create");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid warehouse payload", parsed.error.issues);
  const { branchId, name } = parsed.data;
  assertBranchAccess(session, branchId);

  const branch = await prisma.branch.findFirst({ where: { orgId: session.orgId, id: branchId } });
  if (!branch) throw new ValidationError("branchId does not belong to this organization");
  if (!branch.isActive) throw new ValidationError("Cannot add a warehouse to an inactive branch");

  try {
    return await prisma.$transaction(async (tx) => {
      const wh = await tx.warehouse.create({ data: { orgId: session.orgId, branchId, name } });
      await recordAudit(tx, {
        orgId: session.orgId,
        branchId,
        actorUserId: session.userId,
        entityType: "warehouse",
        entityId: wh.id,
        action: "create",
        afterValue: { name, branchId },
      });
      return wh;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError(`This branch already has a warehouse named "${name}"`);
    throw err;
  }
}

export async function listWarehouses(session: AuthenticatedSession) {
  assertCapability(session.role, "stock:read");
  return prisma.warehouse.findMany({
    where: {
      orgId: session.orgId,
      ...(session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } }),
    },
    orderBy: [{ branchId: "asc" }, { name: "asc" }],
  });
}

// Warehouse lookup that treats "other org" and "branch I can't access"
// identically (null) so existence is never disclosed.
export async function findWarehouseInScope(session: AuthenticatedSession, id: string) {
  const wh = await prisma.warehouse.findFirst({ where: { orgId: session.orgId, id } });
  if (!wh || !hasBranchAccess(session, wh.branchId)) return null;
  return wh;
}
