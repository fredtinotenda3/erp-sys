// Bill of Materials versioning. Core invariant (ARCHITECTURE.md §3.2, §4.C):
// a BOM version is NEVER mutated once created — "editing" a BOM means
// creating a new version (status `draft`), then explicitly activating it,
// which supersedes whatever version was previously `active`. A
// ProductionJob snapshots the specific BOM version it was created against
// (its own `bomId` FK), so activating version 5 here never retroactively
// changes what version 3 means to a job created while version 3 was active
// — this module guarantees that by construction (no UPDATE ever touches an
// existing BomLine row; a new version is entirely new rows).
import { z } from "zod";
import { prisma, isUniqueConstraintError } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

// Redeclared as a plain string-literal union — same reasoning as
// item-service.ts's ITEM_TYPE_VALUES / shared/authz.ts's ROLE_VALUES.
// Confirm against prisma/schema.prisma's `enum BomStatus` after your next
// `prisma generate`.
export const BOM_STATUS_VALUES = ["draft", "active", "superseded"] as const;
export type BomStatus = (typeof BOM_STATUS_VALUES)[number];

const bomLineSchema = z.object({
  materialItemId: z.string().uuid(),
  quantity: z.number().finite().positive(),
  uom: z.string().trim().min(1).max(20),
});

const createBomVersionSchema = z.object({
  effectiveFrom: z.coerce.date().optional(),
  lines: z.array(bomLineSchema).min(1, "A BOM must have at least one material line").max(200),
});

async function assertProductItemExists(orgId: string, productItemId: string) {
  const item = await prisma.item.findFirst({ where: { orgId, id: productItemId } });
  if (!item) throw new NotFoundError("Item");
  return item;
}

export async function createBomVersion(session: AuthenticatedSession, productItemId: string, input: unknown) {
  assertCapability(session.role, "bom:create");
  const parsed = createBomVersionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid BOM payload", parsed.error.issues);
  const data = parsed.data;

  await assertProductItemExists(session.orgId, productItemId);

  // Every materialItemId must resolve to a real, org-owned item. One
  // findMany + count comparison, same pattern as user-service.ts's
  // branchIds validation — not a per-line round trip.
  const materialIds = [...new Set(data.lines.map((l) => l.materialItemId))];
  const validMaterials = await prisma.item.findMany({
    where: { orgId: session.orgId, id: { in: materialIds } },
    select: { id: true },
  });
  if (validMaterials.length !== materialIds.length) {
    throw new ValidationError("One or more materialItemId values do not belong to this organization");
  }

  const latest = await prisma.billOfMaterial.findFirst({
    where: { orgId: session.orgId, productItemId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const nextVersion = (latest?.version ?? 0) + 1;

  try {
    const bom = await prisma.$transaction(async (tx) => {
      const created = await tx.billOfMaterial.create({
        data: {
          orgId: session.orgId,
          productItemId,
          version: nextVersion,
          status: "draft",
          effectiveFrom: data.effectiveFrom ?? null,
          createdById: session.userId,
        },
      });
      await tx.bomLine.createMany({
        data: data.lines.map((line) => ({
          orgId: session.orgId,
          bomId: created.id,
          materialItemId: line.materialItemId,
          quantity: line.quantity,
          uom: line.uom,
        })),
      });
      await recordAudit(tx, {
        orgId: session.orgId,
        actorUserId: session.userId,
        entityType: "bill_of_material",
        entityId: created.id,
        action: "create",
        afterValue: { productItemId, version: nextVersion, lineCount: data.lines.length },
      });
      return created;
    });

    return prisma.billOfMaterial.findFirst({ where: { id: bom.id }, include: { lines: true } });
  } catch (err) {
    // The (productItemId, version) unique constraint can only collide here
    // under a genuine race — two requests both read "no version yet" (or
    // the same latest version) and both tried to claim the same next
    // number. Narrow window, recoverable by retrying the request; not
    // worth a SERIALIZABLE transaction or advisory lock for this traffic
    // pattern. Same risk tolerance as user-service.ts's
    // assertNotLastActiveOwnerAdmin header comment — flag if you've seen
    // this actually collide in practice.
    if (isUniqueConstraintError(err)) {
      throw new ConflictError("Another BOM version was just created for this item — retry the request");
    }
    throw err;
  }
}

export async function listBomVersions(session: AuthenticatedSession, productItemId: string) {
  assertCapability(session.role, "bom:read");
  await assertProductItemExists(session.orgId, productItemId);

  return prisma.billOfMaterial.findMany({
    where: { orgId: session.orgId, productItemId },
    orderBy: { version: "desc" },
    include: { lines: true },
  });
}

// Returns null, not a 404, when no version is active yet — "no active BOM"
// is an expected state for a newly created product (UX_UI_ARCHITECTURE.md
// §2.6's failure state), not an error condition.
export async function getActiveBom(session: AuthenticatedSession, productItemId: string) {
  assertCapability(session.role, "bom:read");
  await assertProductItemExists(session.orgId, productItemId);

  return prisma.billOfMaterial.findFirst({
    where: { orgId: session.orgId, productItemId, status: "active" },
    include: { lines: true },
  });
}

// Activating a version is the only way an "active" BOM changes — and it
// never mutates the version being superseded or the version being
// activated; it only flips two `status` columns. Idempotent: activating an
// already-active version is a no-op success, mirroring
// branch-service.ts's grantBranchAccess idempotency.
export async function activateBomVersion(session: AuthenticatedSession, productItemId: string, bomId: string) {
  assertCapability(session.role, "bom:activate");

  const target = await prisma.billOfMaterial.findFirst({
    where: { orgId: session.orgId, id: bomId, productItemId },
  });
  if (!target) throw new NotFoundError("BOM version");
  if (target.status === "active") return prisma.billOfMaterial.findFirst({ where: { id: target.id }, include: { lines: true } });

  // Reactivating a superseded version is refused rather than silently
  // allowed — once version 4 supersedes version 3, going back to 3 would
  // mean a job created against version 5 later and a job created against
  // "reactivated" version 3 both look like ordinary active-version
  // snapshots, which erases the fact that 3 was ever superseded. If you
  // genuinely need version 3's lines again, create a new version with the
  // same lines — that keeps the history honest. This is a default, not a
  // spec answer from ARCHITECTURE.md — flag if you want it reopened.
  if (target.status === "superseded") {
    throw new ConflictError("Cannot reactivate a superseded BOM version — create a new version with the same lines instead");
  }

  const currentActive = await prisma.billOfMaterial.findFirst({
    where: { orgId: session.orgId, productItemId, status: "active" },
  });

  const activated = await prisma.$transaction(async (tx) => {
    // Supersede the current active version FIRST, then activate the
    // target — never both rows "active" at once, even transiently within
    // the transaction, which is what the partial unique index on
    // (product_item_id) WHERE status='active' (docs/schema.sql) exists to
    // guarantee at the DB level too.
    if (currentActive) {
      await tx.billOfMaterial.update({ where: { id: currentActive.id }, data: { status: "superseded" } });
      await recordAudit(tx, {
        orgId: session.orgId,
        actorUserId: session.userId,
        entityType: "bill_of_material",
        entityId: currentActive.id,
        action: "transition",
        beforeValue: { status: "active" },
        afterValue: { status: "superseded" },
        reason: `superseded by version ${target.version}`,
      });
    }

    const updated = await tx.billOfMaterial.update({
      where: { id: target.id },
      data: { status: "active", effectiveFrom: target.effectiveFrom ?? new Date() },
    });
    await recordAudit(tx, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "bill_of_material",
      entityId: target.id,
      action: "transition",
      beforeValue: { status: "draft" },
      afterValue: { status: "active" },
    });
    return updated;
  });

  return prisma.billOfMaterial.findFirst({ where: { id: activated.id }, include: { lines: true } });
}
