// Machines & work centres (Milestone 4): the shop-floor resource register
// that routing/stages, machine-time, and the capacity-visibility report all
// key off of. Two levels, same relationship as Warehouse is to Branch:
//   WorkCentre -- a department/area in one branch (e.g. "Extrusion").
//   Machine    -- one piece of equipment inside a work centre.
//
// Downtime and maintenance are logged against a MACHINE (not the work
// centre), append-and-close records: opening one is a plain insert; closing
// it (ended_at / completed_at) is the one legitimate update that same row
// ever receives (mirrors Dispatch's own "mostly immutable, a few columns
// close it out" pattern -- see dispatch-service.ts's header).
//
// Scope and branch isolation: a WorkCentre belongs to exactly one branch
// (same as Warehouse); a Machine belongs to exactly one WorkCentre and
// therefore inherits its branch. Every read/write below re-derives branch
// access from the work centre, never trusts a caller-supplied branchId.
import { z } from "zod";
import { prisma, isUniqueConstraintError } from "../../shared/db";
import { assertCapability, assertBranchAccess, hasBranchAccess } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

const MACHINE_STATUS_VALUES = ["available", "in_use", "down", "maintenance", "retired"] as const;
const DOWNTIME_CATEGORY_VALUES = ["breakdown", "changeover", "no_material", "no_operator", "planned_maintenance", "other"] as const;
const MAINTENANCE_TYPE_VALUES = ["scheduled", "unscheduled"] as const;

// ----------------------------------------------------------------------------
// Work centres
// ----------------------------------------------------------------------------
const createWorkCentreSchema = z.object({
  branchId: z.string().uuid(),
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(100),
  dailyCapacityMinutes: z.number().int().nonnegative().max(1440 * 7).nullish(), // generous upper bound; not a shift calendar
});

const updateWorkCentreSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    dailyCapacityMinutes: z.number().int().nonnegative().max(1440 * 7).nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

export async function createWorkCentre(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "machine:manage");
  const parsed = createWorkCentreSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid work centre payload", parsed.error.issues);
  const d = parsed.data;
  assertBranchAccess(session, d.branchId);

  const branch = await prisma.branch.findFirst({ where: { orgId: session.orgId, id: d.branchId } });
  if (!branch) throw new ValidationError("branchId does not belong to this organization");
  if (!branch.isActive) throw new ValidationError("Cannot add a work centre to an inactive branch");

  try {
    return await prisma.$transaction(async (tx) => {
      const wc = await tx.workCentre.create({
        data: { orgId: session.orgId, branchId: d.branchId, code: d.code, name: d.name, dailyCapacityMinutes: d.dailyCapacityMinutes ?? null },
      });
      await recordAudit(tx, { orgId: session.orgId, branchId: d.branchId, actorUserId: session.userId, entityType: "work_centre", entityId: wc.id, action: "create", afterValue: { code: d.code, name: d.name } });
      return wc;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError(`This branch already has a work centre coded "${d.code}"`);
    throw err;
  }
}

export async function listWorkCentres(session: AuthenticatedSession, filter: { branchId?: string } = {}) {
  assertCapability(session.role, "machine:read");
  if (filter.branchId) assertBranchAccess(session, filter.branchId);
  return prisma.workCentre.findMany({
    where: {
      orgId: session.orgId,
      ...(filter.branchId ? { branchId: filter.branchId } : session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } }),
    },
    include: { machines: { orderBy: { code: "asc" } } },
    orderBy: [{ branchId: "asc" }, { code: "asc" }],
  });
}

// Treats "other org" and "branch I can't access" identically (null) so
// existence is never disclosed -- same convention as findWarehouseInScope.
export async function findWorkCentreInScope(session: AuthenticatedSession, id: string) {
  const wc = await prisma.workCentre.findFirst({ where: { orgId: session.orgId, id } });
  if (!wc || !hasBranchAccess(session, wc.branchId)) return null;
  return wc;
}

export async function getWorkCentre(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "machine:read");
  const wc = await findWorkCentreInScope(session, id);
  if (!wc) throw new NotFoundError("Work centre");
  const machines = await prisma.machine.findMany({ where: { orgId: session.orgId, workCentreId: id }, orderBy: { code: "asc" } });
  return { ...wc, machines };
}

export async function updateWorkCentre(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "machine:manage");
  const parsed = updateWorkCentreSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid work centre update", parsed.error.issues);
  const d = parsed.data;

  const wc = await findWorkCentreInScope(session, id);
  if (!wc) throw new NotFoundError("Work centre");

  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (d.name !== undefined) { data.name = d.name; before.name = wc.name; after.name = d.name; }
  if (d.dailyCapacityMinutes !== undefined) { data.dailyCapacityMinutes = d.dailyCapacityMinutes; before.dailyCapacityMinutes = wc.dailyCapacityMinutes; after.dailyCapacityMinutes = d.dailyCapacityMinutes; }
  if (d.isActive !== undefined) { data.isActive = d.isActive; before.isActive = wc.isActive; after.isActive = d.isActive; }

  await prisma.$transaction(async (tx) => {
    await tx.workCentre.update({ where: { id: wc.id }, data });
    await recordAudit(tx, { orgId: session.orgId, branchId: wc.branchId, actorUserId: session.userId, entityType: "work_centre", entityId: wc.id, action: "update", beforeValue: before, afterValue: after });
  });
  return getWorkCentre(session, id);
}

// ----------------------------------------------------------------------------
// Machines
// ----------------------------------------------------------------------------
const createMachineSchema = z.object({
  workCentreId: z.string().uuid(),
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(100),
});

const updateMachineSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    isActive: z.boolean(),
    // Status is also changed as a side effect of opening/closing a downtime
    // record (below) -- this direct setter is for the other transitions
    // (available <-> in_use, or retiring a machine) that aren't downtime.
    status: z.enum(MACHINE_STATUS_VALUES),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

export async function createMachine(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "machine:manage");
  const parsed = createMachineSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid machine payload", parsed.error.issues);
  const d = parsed.data;

  const wc = await findWorkCentreInScope(session, d.workCentreId);
  if (!wc) throw new ValidationError("workCentreId does not belong to a work centre you can access");
  if (!wc.isActive) throw new ValidationError("Cannot add a machine to an inactive work centre");

  try {
    return await prisma.$transaction(async (tx) => {
      const m = await tx.machine.create({ data: { orgId: session.orgId, workCentreId: d.workCentreId, code: d.code, name: d.name } });
      await recordAudit(tx, { orgId: session.orgId, branchId: wc.branchId, actorUserId: session.userId, entityType: "machine", entityId: m.id, action: "create", afterValue: { code: d.code, name: d.name, workCentreId: d.workCentreId } });
      return m;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError(`This work centre already has a machine coded "${d.code}"`);
    throw err;
  }
}

export async function listMachines(session: AuthenticatedSession, filter: { workCentreId?: string; branchId?: string; status?: (typeof MACHINE_STATUS_VALUES)[number] } = {}) {
  assertCapability(session.role, "machine:read");
  if (filter.branchId) assertBranchAccess(session, filter.branchId);
  const where: Record<string, unknown> = { orgId: session.orgId };
  if (filter.workCentreId) {
    const wc = await findWorkCentreInScope(session, filter.workCentreId);
    if (!wc) throw new ValidationError("workCentreId does not belong to a work centre you can access");
    where.workCentreId = filter.workCentreId;
  } else {
    where.workCentre = {
      ...(filter.branchId ? { branchId: filter.branchId } : session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } }),
    };
  }
  if (filter.status) where.status = filter.status;
  return prisma.machine.findMany({ where, include: { workCentre: { select: { id: true, code: true, name: true, branchId: true } } }, orderBy: [{ code: "asc" }] });
}

export async function findMachineInScope(session: AuthenticatedSession, id: string) {
  const m = await prisma.machine.findFirst({ where: { orgId: session.orgId, id }, include: { workCentre: true } });
  if (!m || !hasBranchAccess(session, m.workCentre.branchId)) return null;
  return m;
}

export async function getMachine(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "machine:read");
  const m = await findMachineInScope(session, id);
  if (!m) throw new NotFoundError("Machine");
  const [openDowntime, recentDowntime, maintenance] = await Promise.all([
    prisma.machineDowntimeRecord.findFirst({ where: { orgId: session.orgId, machineId: id, endedAt: null } }),
    prisma.machineDowntimeRecord.findMany({ where: { orgId: session.orgId, machineId: id }, orderBy: { startedAt: "desc" }, take: 20 }),
    prisma.machineMaintenanceRecord.findMany({ where: { orgId: session.orgId, machineId: id }, orderBy: [{ completedAt: "desc" }, { scheduledAt: "desc" }], take: 20 }),
  ]);
  return { ...m, openDowntime, recentDowntime, maintenance };
}

export async function updateMachine(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "machine:manage");
  const parsed = updateMachineSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid machine update", parsed.error.issues);
  const d = parsed.data;

  const m = await findMachineInScope(session, id);
  if (!m) throw new NotFoundError("Machine");
  if (d.status === "down") {
    throw new ValidationError('Use the downtime endpoints to move a machine to "down" -- it must be tied to an open downtime record');
  }
  // d.status, if present, can never be "down" here -- the check above
  // already threw for that case -- so this only guards the OTHER
  // transitions away from "down" (e.g. back to available/in_use).
  if (m.status === "down" && d.status) {
    const open = await prisma.machineDowntimeRecord.findFirst({ where: { orgId: session.orgId, machineId: id, endedAt: null } });
    if (open) throw new ConflictError("This machine has an open downtime record -- close it before changing its status");
  }

  const data: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (d.name !== undefined) { data.name = d.name; before.name = m.name; after.name = d.name; }
  if (d.isActive !== undefined) { data.isActive = d.isActive; before.isActive = m.isActive; after.isActive = d.isActive; }
  if (d.status !== undefined) { data.status = d.status; before.status = m.status; after.status = d.status; }

  await prisma.$transaction(async (tx) => {
    await tx.machine.update({ where: { id: m.id }, data });
    await recordAudit(tx, { orgId: session.orgId, branchId: m.workCentre.branchId, actorUserId: session.userId, entityType: "machine", entityId: m.id, action: "update", beforeValue: before, afterValue: after });
  });
  return getMachine(session, id);
}

// ----------------------------------------------------------------------------
// Downtime -- open/close. Opening sets the machine's status to "down" in the
// same transaction; closing restores it to "available" (an operator who
// needs "in_use" instead can set that explicitly afterwards via
// updateMachine). The partial unique index on (machine_id) WHERE
// ended_at IS NULL (migration 20261108090000) guarantees at the database
// level that a machine can't have two open downtime records.
// ----------------------------------------------------------------------------
const openDowntimeSchema = z.object({
  category: z.enum(DOWNTIME_CATEGORY_VALUES),
  reason: z.string().trim().min(3, "Give a brief reason").max(500),
});

const closeDowntimeSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export async function openDowntime(session: AuthenticatedSession, machineId: string, input: unknown) {
  assertCapability(session.role, "machine:manage");
  const parsed = openDowntimeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid downtime payload", parsed.error.issues);
  const d = parsed.data;

  const m = await findMachineInScope(session, machineId);
  if (!m) throw new NotFoundError("Machine");
  if (m.status === "down") throw new ConflictError("This machine already has an open downtime record");
  if (m.status === "retired") throw new ValidationError("A retired machine cannot be marked down");

  try {
    return await prisma.$transaction(async (tx) => {
      const rec = await tx.machineDowntimeRecord.create({ data: { orgId: session.orgId, machineId, category: d.category, reason: d.reason, loggedById: session.userId } });
      await tx.machine.update({ where: { id: machineId }, data: { status: "down" } });
      await recordAudit(tx, { orgId: session.orgId, branchId: m.workCentre.branchId, actorUserId: session.userId, entityType: "machine_downtime_record", entityId: rec.id, action: "create", afterValue: { machineId, category: d.category }, reason: d.reason });
      return rec;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) throw new ConflictError("This machine already has an open downtime record");
    throw err;
  }
}

export async function closeDowntime(session: AuthenticatedSession, machineId: string, downtimeId: string, input: unknown = {}) {
  assertCapability(session.role, "machine:manage");
  const parsed = closeDowntimeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid close-downtime payload", parsed.error.issues);

  const m = await findMachineInScope(session, machineId);
  if (!m) throw new NotFoundError("Machine");
  const rec = await prisma.machineDowntimeRecord.findFirst({ where: { orgId: session.orgId, id: downtimeId, machineId } });
  if (!rec) throw new NotFoundError("Downtime record");
  if (rec.endedAt) throw new ConflictError("This downtime record is already closed");

  return prisma.$transaction(async (tx) => {
    const closed = await tx.machineDowntimeRecord.update({
      where: { id: rec.id },
      data: { endedAt: new Date(), ...(parsed.data.notes ? { reason: `${rec.reason} — ${parsed.data.notes}` } : {}) },
    });
    await tx.machine.update({ where: { id: machineId }, data: { status: "available" } });
    await recordAudit(tx, { orgId: session.orgId, branchId: m.workCentre.branchId, actorUserId: session.userId, entityType: "machine_downtime_record", entityId: rec.id, action: "update", beforeValue: { endedAt: null }, afterValue: { endedAt: closed.endedAt } });
    return closed;
  });
}

// ----------------------------------------------------------------------------
// Maintenance -- schedule (type + future scheduledAt, completedAt null) and
// record/complete (stamp completedAt on an existing row, or create one with
// completedAt already set for maintenance done without prior scheduling).
// ----------------------------------------------------------------------------
const scheduleMaintenanceSchema = z.object({
  type: z.enum(MAINTENANCE_TYPE_VALUES),
  scheduledAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
});

const completeMaintenanceSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});

export async function scheduleMaintenance(session: AuthenticatedSession, machineId: string, input: unknown) {
  assertCapability(session.role, "machine:manage");
  const parsed = scheduleMaintenanceSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid maintenance payload", parsed.error.issues);
  const d = parsed.data;
  if (d.type === "scheduled" && !d.scheduledAt) throw new ValidationError("scheduledAt is required for scheduled maintenance");

  const m = await findMachineInScope(session, machineId);
  if (!m) throw new NotFoundError("Machine");

  return prisma.$transaction(async (tx) => {
    const rec = await tx.machineMaintenanceRecord.create({
      data: { orgId: session.orgId, machineId, type: d.type, scheduledAt: d.scheduledAt ?? null, notes: d.notes ?? null, performedById: session.userId },
    });
    await recordAudit(tx, { orgId: session.orgId, branchId: m.workCentre.branchId, actorUserId: session.userId, entityType: "machine_maintenance_record", entityId: rec.id, action: "create", afterValue: { machineId, type: d.type, scheduledAt: d.scheduledAt ?? null } });
    return rec;
  });
}

export async function completeMaintenance(session: AuthenticatedSession, machineId: string, maintenanceId: string, input: unknown = {}) {
  assertCapability(session.role, "machine:manage");
  const parsed = completeMaintenanceSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid payload", parsed.error.issues);

  const m = await findMachineInScope(session, machineId);
  if (!m) throw new NotFoundError("Machine");
  const rec = await prisma.machineMaintenanceRecord.findFirst({ where: { orgId: session.orgId, id: maintenanceId, machineId } });
  if (!rec) throw new NotFoundError("Maintenance record");
  if (rec.completedAt) throw new ConflictError("This maintenance record is already completed");

  return prisma.$transaction(async (tx) => {
    const completed = await tx.machineMaintenanceRecord.update({
      where: { id: rec.id },
      data: { completedAt: new Date(), performedById: session.userId, ...(parsed.data.notes ? { notes: [rec.notes, parsed.data.notes].filter(Boolean).join(" — ") } : {}) },
    });
    // If the machine was parked in "maintenance" status for this work, completing it returns it to available.
    if (m.status === "maintenance") await tx.machine.update({ where: { id: machineId }, data: { status: "available" } });
    await recordAudit(tx, { orgId: session.orgId, branchId: m.workCentre.branchId, actorUserId: session.userId, entityType: "machine_maintenance_record", entityId: rec.id, action: "update", beforeValue: { completedAt: null }, afterValue: { completedAt: completed.completedAt } });
    return completed;
  });
}
