// Inspection plans (Milestone 4): "what to check and its tolerances" for an
// item -- a material (incoming inspection) or a manufactured product
// (in-process/final inspection). See prisma/schema.prisma's comment above
// InspectionPlan for why this is deliberately NOT versioned the way
// BillOfMaterial is: every recorded measurement copies its characteristic's
// name/uom/min/max at write time (quality-service.ts's recordInspection), so
// editing a plan later can't retroactively change what a past measurement
// meant. A characteristic already used by a measurement is retired
// (isActive=false), never deleted -- its FK must stay live.
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

const characteristicInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    uom: z.string().trim().max(20).optional(),
    minValue: z.number().finite().optional(),
    maxValue: z.number().finite().optional(),
    targetValue: z.number().finite().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.minValue !== undefined && d.maxValue !== undefined && d.minValue > d.maxValue) {
      ctx.addIssue({ code: "custom", message: "minValue cannot exceed maxValue", path: ["minValue"] });
    }
  });

const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(100),
  characteristics: z.array(characteristicInput).min(1).max(100),
});

const addCharacteristicSchema = characteristicInput;

const updateCharacteristicSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    uom: z.string().trim().max(20).nullable(),
    minValue: z.number().finite().nullable(),
    maxValue: z.number().finite().nullable(),
    targetValue: z.number().finite().nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .strict()
  .refine((d) => Object.keys(d).length > 0, "Provide at least one field to update");

async function assertItemExists(orgId: string, itemId: string) {
  const item = await prisma.item.findFirst({ where: { orgId, id: itemId } });
  if (!item) throw new NotFoundError("Item");
  return item;
}

export async function createInspectionPlan(session: AuthenticatedSession, itemId: string, input: unknown) {
  assertCapability(session.role, "quality_plan:manage");
  const parsed = createPlanSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid inspection plan payload", parsed.error.issues);
  const d = parsed.data;
  await assertItemExists(session.orgId, itemId);

  return prisma.$transaction(async (tx) => {
    const plan = await tx.inspectionPlan.create({ data: { orgId: session.orgId, itemId, name: d.name, createdById: session.userId } });
    await tx.inspectionCharacteristic.createMany({
      data: d.characteristics.map((c, i) => ({
        orgId: session.orgId,
        planId: plan.id,
        name: c.name,
        uom: c.uom ?? null,
        minValue: c.minValue ?? null,
        maxValue: c.maxValue ?? null,
        targetValue: c.targetValue ?? null,
        sequence: i + 1,
      })),
    });
    await recordAudit(tx, { orgId: session.orgId, actorUserId: session.userId, entityType: "inspection_plan", entityId: plan.id, action: "create", afterValue: { itemId, name: d.name, characteristicCount: d.characteristics.length } });
    return tx.inspectionPlan.findFirst({ where: { id: plan.id }, include: { characteristics: { orderBy: { sequence: "asc" } } } });
  });
}

export async function listInspectionPlans(session: AuthenticatedSession, itemId: string) {
  assertCapability(session.role, "quality:read");
  await assertItemExists(session.orgId, itemId);
  return prisma.inspectionPlan.findMany({
    where: { orgId: session.orgId, itemId },
    include: { characteristics: { orderBy: { sequence: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getInspectionPlan(session: AuthenticatedSession, planId: string) {
  assertCapability(session.role, "quality:read");
  const plan = await prisma.inspectionPlan.findFirst({ where: { orgId: session.orgId, id: planId }, include: { characteristics: { orderBy: { sequence: "asc" } } } });
  if (!plan) throw new NotFoundError("Inspection plan");
  return plan;
}

export async function updateInspectionPlan(session: AuthenticatedSession, planId: string, input: unknown) {
  assertCapability(session.role, "quality_plan:manage");
  const parsed = z.object({ name: z.string().trim().min(1).max(100).optional(), isActive: z.boolean().optional() }).refine((d) => d.name !== undefined || d.isActive !== undefined, "Provide at least one field to update").safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid update", parsed.error.issues);

  const plan = await prisma.inspectionPlan.findFirst({ where: { orgId: session.orgId, id: planId } });
  if (!plan) throw new NotFoundError("Inspection plan");

  await prisma.$transaction(async (tx) => {
    await tx.inspectionPlan.update({ where: { id: plan.id }, data: parsed.data });
    await recordAudit(tx, { orgId: session.orgId, actorUserId: session.userId, entityType: "inspection_plan", entityId: plan.id, action: "update", beforeValue: { name: plan.name, isActive: plan.isActive }, afterValue: parsed.data });
  });
  return getInspectionPlan(session, planId);
}

export async function addCharacteristic(session: AuthenticatedSession, planId: string, input: unknown) {
  assertCapability(session.role, "quality_plan:manage");
  const parsed = addCharacteristicSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid characteristic payload", parsed.error.issues);
  const d = parsed.data;

  const plan = await prisma.inspectionPlan.findFirst({ where: { orgId: session.orgId, id: planId } });
  if (!plan) throw new NotFoundError("Inspection plan");

  const maxSeq = await prisma.inspectionCharacteristic.aggregate({ where: { orgId: session.orgId, planId }, _max: { sequence: true } });
  return prisma.$transaction(async (tx) => {
    const c = await tx.inspectionCharacteristic.create({
      data: { orgId: session.orgId, planId, name: d.name, uom: d.uom ?? null, minValue: d.minValue ?? null, maxValue: d.maxValue ?? null, targetValue: d.targetValue ?? null, sequence: (maxSeq._max.sequence ?? 0) + 1 },
    });
    await recordAudit(tx, { orgId: session.orgId, actorUserId: session.userId, entityType: "inspection_characteristic", entityId: c.id, action: "create", afterValue: { planId, name: d.name } });
    return c;
  });
}

// Editing bounds does NOT retroactively change past measurements (they
// copied the values at write time -- see the file header), but a
// characteristic that already has measurements against it can only be
// retired (isActive:false), not renamed or have its bounds changed: that
// would make its *next* measurement mean something different under the
// same name, which is confusing even though technically safe for history.
export async function updateCharacteristic(session: AuthenticatedSession, characteristicId: string, input: unknown) {
  assertCapability(session.role, "quality_plan:manage");
  const parsed = updateCharacteristicSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid update", parsed.error.issues);
  const d = parsed.data;

  const c = await prisma.inspectionCharacteristic.findFirst({ where: { orgId: session.orgId, id: characteristicId } });
  if (!c) throw new NotFoundError("Inspection characteristic");

  const changingDefinition = d.name !== undefined || d.uom !== undefined || d.minValue !== undefined || d.maxValue !== undefined || d.targetValue !== undefined;
  if (changingDefinition) {
    const used = await prisma.qualityMeasurement.count({ where: { orgId: session.orgId, characteristicId } });
    if (used > 0) throw new ConflictError("This characteristic already has recorded measurements -- retire it (isActive:false) and add a new one instead of changing its definition");
  }

  await prisma.$transaction(async (tx) => {
    await tx.inspectionCharacteristic.update({ where: { id: c.id }, data: d });
    await recordAudit(tx, { orgId: session.orgId, actorUserId: session.userId, entityType: "inspection_characteristic", entityId: c.id, action: "update", beforeValue: { name: c.name, isActive: c.isActive }, afterValue: d });
  });
  return prisma.inspectionCharacteristic.findFirst({ where: { id: c.id } });
}
