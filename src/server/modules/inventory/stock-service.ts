// Stock receipts, adjustments and read models (balances, movement history).
//
// Every quantity change is a StockMovement row (immutable ledger). There is no
// "set stock to N" anywhere. "Why is stock 450?" is answered by listMovements.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, assertBranchAccess, hasCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";
import { findWarehouseInScope } from "./warehouse-service";
import { checkReplay, findByClientRequestId, postMovement, readBalance, toMovementView } from "./stock-core";

const dp = (n: number, places: number) => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-6;

const qty = z.number().finite().max(1_000_000_000).refine((n) => dp(n, 4), "quantity supports at most 4 decimal places");
const positiveQty = qty.refine((n) => n > 0, "quantity must be greater than zero");
const unitCost = z
  .number()
  .finite()
  .nonnegative()
  .max(1_000_000_000)
  .refine((n) => dp(n, 4), "unitCost supports at most 4 decimal places");
const currency = z.string().trim().toUpperCase().length(3);
const occurredAt = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, "occurredAt cannot be in the future")
  .optional();

const receiptSchema = z.object({
  clientRequestId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  itemId: z.string().uuid(),
  quantity: positiveQty,
  unitCost,
  currency,
  note: z.string().trim().max(500).optional(), // free-text supplier / delivery-note reference (suppliers module is Phase 6)
  occurredAt,
});

const adjustmentSchema = z
  .object({
    clientRequestId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    itemId: z.string().uuid(),
    quantity: qty.refine((n) => n !== 0, "quantity cannot be zero"), // signed
    unitCost: unitCost.optional(),
    currency: currency.optional(),
    reason: z.string().trim().min(3, "An adjustment needs a reason").max(500),
    occurredAt,
  })
  .superRefine((d, ctx) => {
    if (d.quantity > 0) {
      if (d.unitCost === undefined || d.currency === undefined) {
        ctx.addIssue({ code: "custom", message: "A positive adjustment needs unitCost and currency", path: ["unitCost"] });
      }
    } else if (d.unitCost !== undefined || d.currency !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A negative adjustment is valued at the current average cost; do not supply unitCost/currency",
        path: ["unitCost"],
      });
    }
  });

async function requireItem(session: AuthenticatedSession, itemId: string) {
  const item = await prisma.item.findFirst({ where: { orgId: session.orgId, id: itemId } });
  if (!item) throw new ValidationError("itemId does not belong to this organization");
  if (!item.isActive) throw new ValidationError("Cannot move stock for an inactive item");
  return item;
}

async function requireCurrency(code: string) {
  const c = await prisma.currency.findUnique({ where: { code } });
  if (!c) throw new ValidationError(`Unknown currency code "${code}"`);
}

export async function receiveStock(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "stock:receive");
  const parsed = receiptSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid receipt payload", parsed.error.issues);
  const d = parsed.data;

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");
  if (!warehouse.isActive) throw new ValidationError("Cannot receive stock into an inactive warehouse");

  const item = await requireItem(session, d.itemId);
  if (item.itemType === "finished_good" || item.itemType === "wip") {
    throw new ValidationError("Purchase receipts are for raw materials, consumables and spare parts");
  }
  await requireCurrency(d.currency);

  const args = {
    warehouse: { id: warehouse.id, branchId: warehouse.branchId },
    itemId: item.id,
    movementType: "purchase_receipt" as const,
    quantity: new Prisma.Decimal(d.quantity),
    unitCost: new Prisma.Decimal(d.unitCost),
    currency: d.currency,
    referenceType: "manual" as const,
    referenceId: null,
    reason: d.note ?? null,
    clientRequestId: d.clientRequestId,
    occurredAt: d.occurredAt,
  };

  const existing = await findByClientRequestId(session.orgId, d.clientRequestId);
  const result = existing ? checkReplay(existing, args) : await postMovement(session, args);
  return {
    replayed: result.replayed,
    movement: toMovementView(session.role, result.movement),
    balance: await readBalance(session, item.id, warehouse.id),
  };
}

export async function adjustStock(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "stock:adjust");
  const parsed = adjustmentSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid adjustment payload", parsed.error.issues);
  const d = parsed.data;

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");
  if (!warehouse.isActive) throw new ValidationError("Cannot adjust stock in an inactive warehouse");
  const item = await requireItem(session, d.itemId);
  if (d.currency) await requireCurrency(d.currency);

  const args = {
    warehouse: { id: warehouse.id, branchId: warehouse.branchId },
    itemId: item.id,
    movementType: "adjustment" as const,
    quantity: new Prisma.Decimal(d.quantity),
    unitCost: d.unitCost !== undefined ? new Prisma.Decimal(d.unitCost) : null,
    currency: d.currency ?? null,
    referenceType: "manual" as const,
    referenceId: null,
    reason: d.reason,
    clientRequestId: d.clientRequestId,
    occurredAt: d.occurredAt,
  };

  const existing = await findByClientRequestId(session.orgId, d.clientRequestId);
  const result = existing ? checkReplay(existing, args) : await postMovement(session, args);
  return {
    replayed: result.replayed,
    movement: toMovementView(session.role, result.movement),
    balance: await readBalance(session, item.id, warehouse.id),
  };
}

const balanceFilterSchema = z.object({
  warehouseId: z.string().uuid().optional(),
  itemId: z.string().uuid().optional(),
});

export async function listStockBalances(session: AuthenticatedSession, filter: unknown = {}) {
  assertCapability(session.role, "stock:read");
  const parsed = balanceFilterSchema.safeParse(filter);
  if (!parsed.success) throw new ValidationError("Invalid filter", parsed.error.issues);

  const rows = await prisma.stockBalance.findMany({
    where: {
      orgId: session.orgId,
      ...(parsed.data.itemId ? { itemId: parsed.data.itemId } : {}),
      ...(parsed.data.warehouseId ? { warehouseId: parsed.data.warehouseId } : {}),
      // No fallback to org-wide: non-owners only see warehouses in granted branches.
      ...(session.role === "OWNER_ADMIN" ? {} : { warehouse: { branchId: { in: [...session.branchIds] } } }),
    },
    orderBy: [{ itemId: "asc" }, { warehouseId: "asc" }],
  });
  const showCost = hasCapability(session.role, "cost:read");
  return rows.map((b) => ({
    itemId: b.itemId,
    warehouseId: b.warehouseId,
    quantity: b.quantity,
    updatedAt: b.updatedAt,
    ...(showCost ? { averageUnitCost: b.averageUnitCost, averageUnitCostCurrency: b.averageUnitCostCurrency } : {}),
  }));
}

const movementFilterSchema = z.object({
  itemId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  referenceId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/** The answer to "why is current stock what it is": the actual ledger rows. */
export async function listStockMovements(session: AuthenticatedSession, filter: unknown = {}) {
  assertCapability(session.role, "stock:read");
  const parsed = movementFilterSchema.safeParse(filter);
  if (!parsed.success) throw new ValidationError("Invalid filter", parsed.error.issues);
  const f = parsed.data;
  if (f.warehouseId) {
    const wh = await findWarehouseInScope(session, f.warehouseId);
    if (!wh) throw new NotFoundError("Warehouse");
  }

  const rows = await prisma.stockMovement.findMany({
    where: {
      orgId: session.orgId,
      ...(f.itemId ? { itemId: f.itemId } : {}),
      ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}),
      ...(f.referenceId ? { referenceId: f.referenceId } : {}),
      ...(session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } }),
    },
    orderBy: [{ occurredAt: "desc" }, { syncedAt: "desc" }],
    take: f.limit ?? 200,
  });
  return rows.map((m) => toMovementView(session.role, m as never));
}

// Re-exported so route files and tests share one validation of branch access.
export { assertBranchAccess };
