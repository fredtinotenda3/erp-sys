// Moulds (Milestone 6 -- Plastics Manufacturing Vertical). Mirrors
// machine-service.ts's work-centre/machine shape closely: a Mould is
// branch-scoped equipment, many machines can be compatible with one mould
// (a join table, since tonnage/platen size compatibility is genuinely
// many-to-many), but a mould is cut for exactly one product (a single
// optional FK -- see schema.prisma's comment on why this isn't a join
// table too). Usage history is a query over PlasticsProcessDetail.mouldId,
// never a separately stored total.
//
// WRITE operations here require the organization to be on the plastics
// profile (industry-profile-service.ts's assertPlasticsProfileActive).
// READ operations do not -- switching profiles must never hide or corrupt
// historical mould data (Milestone 5's own architecture principle).
import { z } from "zod";
import { prisma, isUniqueConstraintError } from "../../shared/db";
import { assertCapability, assertBranchAccess, hasBranchAccess } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { assertPlasticsProfileActive } from "../industry/industry-profile-service";

const MOULD_STATUS_VALUES = ["available", "in_use", "maintenance", "retired"] as const;
const MAINTENANCE_TYPE_VALUES = ["scheduled", "unscheduled"] as const;

// ----------------------------------------------------------------------------
// Moulds
// ----------------------------------------------------------------------------
const createMouldSchema = z.object({
  branchId: z.string().uuid(),
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(100),
  cavityCount: z.number().int().positive().max(256),
  compatibleProductItemId: z.string().uuid().nullish(),
});

const updateMouldSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    cavityCount: z.number().int().positive().max(256),
    status: z.enum(MOULD_STATUS_VALUES),
    compatibleProductItemId: z.string().uuid().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

async function assertCompatibleProductIsFinishedSide(session: AuthenticatedSession, itemId: string) {
  const item = await prisma.item.findFirst({ where: { orgId: session.orgId, id: itemId } });
  if (!item) throw new ValidationError("compatibleProductItemId does not belong to an item you can access");
  if (item.itemType !== "finished_good" && item.itemType !== "wip") {
    throw new ValidationError("compatibleProductItemId must refer to a finished_good or wip item");
  }
}

export async function createMould(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "mould:manage");
  await assertPlasticsProfileActive(session);
  const parsed = createMouldSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid mould payload", parsed.error.issues);
  const d = parsed.data;
  assertBranchAccess(session, d.branchId);

  const branch = await prisma.branch.findFirst({ where: { orgId: session.orgId, id: d.branchId } });
  if (!branch) throw new ValidationError("branchId does not belong to this organization");
  if (!branch.isActive) throw new ValidationError("Cannot add a mould to an inactive branch");
  if (d.compatibleProductItemId) await assertCompatibleProductIsFinishedSide(session, d.compatibleProductItemId);

  try {
    return await prisma.$transaction(async (tx) => {
      const mould = await tx.mould.create({
        data: {
          orgId: session.orgId,
          branchId: d.branchId,
          code: d.code,
          name: d.name,
          cavityCount: d.cavityCount,
          compatibleProductItemId: d.compatibleProductItemId ?? null,
        },
      });
      await recordAudit(tx, { orgId: session.orgId, branchId: d.branchId, actorUserId: session.userId, entityType: "mould", entityId: mould.id, action: "create", afterValue: { code: d.code, name: d.name, cavityCount: d.cavityCount } });
      return mould;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError(`This branch already has a mould coded "${d.code}"`);
    throw err;
  }
}

export async function listMoulds(session: AuthenticatedSession, filter: { branchId?: string; status?: (typeof MOULD_STATUS_VALUES)[number] } = {}) {
  assertCapability(session.role, "mould:read");
  if (filter.branchId) assertBranchAccess(session, filter.branchId);
  return prisma.mould.findMany({
    where: {
      orgId: session.orgId,
      ...(filter.branchId ? { branchId: filter.branchId } : session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } }),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: [{ branchId: "asc" }, { code: "asc" }],
  });
}

// Treats "other org" and "branch I can't access" identically (null) so
// existence is never disclosed -- same convention as findMachineInScope.
export async function findMouldInScope(session: AuthenticatedSession, id: string) {
  const mould = await prisma.mould.findFirst({ where: { orgId: session.orgId, id } });
  if (!mould || !hasBranchAccess(session, mould.branchId)) return null;
  return mould;
}

export async function getMould(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "mould:read");
  const mould = await findMouldInScope(session, id);
  if (!mould) throw new NotFoundError("Mould");
  const [compatibilities, maintenance] = await Promise.all([
    prisma.mouldMachineCompatibility.findMany({ where: { orgId: session.orgId, mouldId: id } }),
    prisma.mouldMaintenanceRecord.findMany({ where: { orgId: session.orgId, mouldId: id }, orderBy: [{ completedAt: "desc" }, { scheduledAt: "desc" }], take: 20 }),
  ]);
  return { ...mould, compatibleMachineIds: compatibilities.map((c) => c.machineId), maintenance };
}

export async function updateMould(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "mould:manage");
  await assertPlasticsProfileActive(session);
  const parsed = updateMouldSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid mould update", parsed.error.issues);
  const d = parsed.data;

  const mould = await findMouldInScope(session, id);
  if (!mould) throw new NotFoundError("Mould");
  if (d.compatibleProductItemId) await assertCompatibleProductIsFinishedSide(session, d.compatibleProductItemId);

  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of ["name", "cavityCount", "status", "compatibleProductItemId", "isActive"] as const) {
    if (d[key] !== undefined) { data[key] = d[key]; before[key] = (mould as Record<string, unknown>)[key]; after[key] = d[key]; }
  }

  await prisma.$transaction(async (tx) => {
    await tx.mould.update({ where: { id: mould.id }, data });
    await recordAudit(tx, { orgId: session.orgId, branchId: mould.branchId, actorUserId: session.userId, entityType: "mould", entityId: mould.id, action: "update", beforeValue: before, afterValue: after });
  });
  return getMould(session, id);
}

// ----------------------------------------------------------------------------
// Machine compatibility -- add/remove a (mould, machine) pair.
// ----------------------------------------------------------------------------
export async function addMouldMachineCompatibility(session: AuthenticatedSession, mouldId: string, machineId: string) {
  assertCapability(session.role, "mould:manage");
  await assertPlasticsProfileActive(session);
  const mould = await findMouldInScope(session, mouldId);
  if (!mould) throw new NotFoundError("Mould");
  const machine = await prisma.machine.findFirst({ where: { orgId: session.orgId, id: machineId }, include: { workCentre: true } });
  if (!machine || !hasBranchAccess(session, machine.workCentre.branchId)) throw new ValidationError("machineId does not belong to a machine you can access");

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.mouldMachineCompatibility.create({ data: { orgId: session.orgId, mouldId, machineId } });
      await recordAudit(tx, { orgId: session.orgId, branchId: mould.branchId, actorUserId: session.userId, entityType: "mould_machine_compatibility", entityId: row.id, action: "create", afterValue: { mouldId, machineId } });
      return row;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError("This mould is already marked compatible with this machine");
    throw err;
  }
}

export async function removeMouldMachineCompatibility(session: AuthenticatedSession, mouldId: string, machineId: string) {
  assertCapability(session.role, "mould:manage");
  await assertPlasticsProfileActive(session);
  const mould = await findMouldInScope(session, mouldId);
  if (!mould) throw new NotFoundError("Mould");
  const row = await prisma.mouldMachineCompatibility.findFirst({ where: { orgId: session.orgId, mouldId, machineId } });
  if (!row) throw new NotFoundError("Mould/machine compatibility");

  await prisma.$transaction(async (tx) => {
    await tx.mouldMachineCompatibility.delete({ where: { id: row.id } });
    await recordAudit(tx, { orgId: session.orgId, branchId: mould.branchId, actorUserId: session.userId, entityType: "mould_machine_compatibility", entityId: row.id, action: "delete", beforeValue: { mouldId, machineId } });
  });
}

// ----------------------------------------------------------------------------
// Maintenance -- mirrors machine-service.ts's scheduleMaintenance/
// completeMaintenance exactly, reusing the same MaintenanceType enum.
// ----------------------------------------------------------------------------
const scheduleMaintenanceSchema = z.object({
  type: z.enum(MAINTENANCE_TYPE_VALUES),
  scheduledAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
});

const completeMaintenanceSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export async function scheduleMouldMaintenance(session: AuthenticatedSession, mouldId: string, input: unknown) {
  assertCapability(session.role, "mould:manage");
  await assertPlasticsProfileActive(session);
  const parsed = scheduleMaintenanceSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid maintenance payload", parsed.error.issues);
  const d = parsed.data;
  if (d.type === "scheduled" && !d.scheduledAt) throw new ValidationError("scheduledAt is required for scheduled maintenance");

  const mould = await findMouldInScope(session, mouldId);
  if (!mould) throw new NotFoundError("Mould");

  return prisma.$transaction(async (tx) => {
    const rec = await tx.mouldMaintenanceRecord.create({
      data: { orgId: session.orgId, mouldId, type: d.type, scheduledAt: d.scheduledAt ?? null, notes: d.notes ?? null, performedById: session.userId },
    });
    await recordAudit(tx, { orgId: session.orgId, branchId: mould.branchId, actorUserId: session.userId, entityType: "mould_maintenance_record", entityId: rec.id, action: "create", afterValue: { mouldId, type: d.type, scheduledAt: d.scheduledAt ?? null } });
    return rec;
  });
}

export async function completeMouldMaintenance(session: AuthenticatedSession, mouldId: string, maintenanceId: string, input: unknown = {}) {
  assertCapability(session.role, "mould:manage");
  await assertPlasticsProfileActive(session);
  const parsed = completeMaintenanceSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid payload", parsed.error.issues);

  const mould = await findMouldInScope(session, mouldId);
  if (!mould) throw new NotFoundError("Mould");
  const rec = await prisma.mouldMaintenanceRecord.findFirst({ where: { orgId: session.orgId, id: maintenanceId, mouldId } });
  if (!rec) throw new NotFoundError("Maintenance record");
  if (rec.completedAt) throw new ConflictError("This maintenance record is already completed");

  return prisma.$transaction(async (tx) => {
    const completed = await tx.mouldMaintenanceRecord.update({
      where: { id: rec.id },
      data: { completedAt: new Date(), performedById: session.userId, ...(parsed.data.notes ? { notes: [rec.notes, parsed.data.notes].filter(Boolean).join(" — ") } : {}) },
    });
    if (mould.status === "maintenance") await tx.mould.update({ where: { id: mouldId }, data: { status: "available" } });
    await recordAudit(tx, { orgId: session.orgId, branchId: mould.branchId, actorUserId: session.userId, entityType: "mould_maintenance_record", entityId: rec.id, action: "update", beforeValue: { completedAt: null }, afterValue: { completedAt: completed.completedAt } });
    return completed;
  });
}
