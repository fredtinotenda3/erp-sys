// Purchase orders: the commercial record of what the organisation asked a
// supplier for. Mirrors sales-order-service.ts's shape deliberately -- same
// scope discipline, same numbering pattern, same draft/confirm/cancel shape
// -- with the differences the business domain actually requires (see
// prisma/schema.prisma's PurchaseOrder/PurchaseOrderLine comments for the
// full design rationale; this file implements it, not re-derives it).
//
// Scope:
//  - A PO is created as a DRAFT, may be edited while draft, CONFIRMED, or CANCELLED.
//  - Confirming is the one approval gate (purchase_order:confirm, withheld from
//    INVENTORY_MANAGER -- see authz.ts's comment on that role for why).
//  - partially_received / received are set ONLY by goods-receipt-service.ts,
//    never written here directly -- this file has no code path that writes
//    those two status values.
//  - closed is set here (closePurchaseOrder) -- a deliberate manual action
//    after receiving is done, distinct from "received" (see schema comment).
//  - One currency per PO; every line carries the PO's currency, same rule
//    SalesOrder uses and for the same reason (no invented FX/rounding logic
//    at the line level).
//  - Only raw_material / consumable / spare_part items can be ordered --
//    finished_good and wip are produced, not purchased (same restriction
//    stock-service.ts's receiveStock already enforces for manual receipts;
//    duplicated here rather than imported because the two checks run in
//    different validation contexts and importing across modules for one
//    boolean comparison would be the wrong kind of coupling).
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertBranchAccess, assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

export const PURCHASE_ORDER_STATUS_VALUES = ["draft", "confirmed", "partially_received", "received", "closed", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUS_VALUES)[number];

const D = (v: unknown) => new Prisma.Decimal(String(v));
const MAX_QTY = 1_000_000_000;
const MAX_PRICE = 9_999_999_999;
const hasAtMost4dp = (n: number) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6;

const UNPURCHASABLE_ITEM_TYPES = new Set(["finished_good", "wip"]);

const lineSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().finite().positive("Quantity must be greater than zero").max(MAX_QTY).refine(hasAtMost4dp, "Quantity supports at most 4 decimal places"),
  uom: z.string().trim().min(1).max(20),
  unitPrice: z.number().finite().nonnegative("Unit price can't be negative").max(MAX_PRICE).refine(hasAtMost4dp, "Unit price supports at most 4 decimal places"),
});

const deliveryDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real date");

const createSchema = z.object({
  branchId: z.string().uuid(),
  supplierId: z.string().uuid(),
  currency: z.string().trim().toUpperCase().length(3),
  requestedDeliveryDate: deliveryDateSchema.optional(),
  supplierReference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line").max(200),
});

const updateSchema = z
  .object({
    supplierId: z.string().uuid().optional(),
    requestedDeliveryDate: deliveryDateSchema.nullable().optional(),
    supplierReference: z.string().trim().max(100).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    lines: z.array(lineSchema).min(1, "A purchase order needs at least one line").max(200).optional(),
  })
  .refine(
    (d) => d.supplierId !== undefined || d.requestedDeliveryDate !== undefined || d.supplierReference !== undefined || d.notes !== undefined || d.lines !== undefined,
    { message: "No fields supplied to update" },
  );

const cancelSchema = z.object({ reason: z.string().trim().min(3, "Say why in at least 3 characters").max(500) });
const closeSchema = z.object({ reason: z.string().trim().min(3, "Say why in at least 3 characters").max(500) });

type PoRow = Prisma.PurchaseOrderGetPayload<{
  include: {
    supplier: { select: { id: true; name: true; status: true } };
    lines: { include: { item: { select: { sku: true; name: true } } } };
  };
}>;

const INCLUDE = {
  supplier: { select: { id: true, name: true, status: true } },
  lines: { orderBy: { id: "asc" as const }, include: { item: { select: { sku: true, name: true } } } },
} as const;

function branchWhere(session: AuthenticatedSession) {
  return session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } };
}

async function findPoInScope(session: AuthenticatedSession, id: string): Promise<PoRow | null> {
  return prisma.purchaseOrder.findFirst({ where: { orgId: session.orgId, id, ...branchWhere(session) }, include: INCLUDE });
}

/** Sum of accepted goods-receipt quantity per PO line, for every line id supplied. */
async function receivedQtyByLine(orgId: string, lineIds: string[]): Promise<Map<string, Prisma.Decimal>> {
  if (lineIds.length === 0) return new Map();
  const rows = await prisma.goodsReceiptLine.groupBy({
    by: ["poLineId"],
    where: { orgId, poLineId: { in: lineIds } },
    _sum: { acceptedQty: true },
  });
  return new Map(rows.map((r) => [r.poLineId, r._sum.acceptedQty ?? D(0)]));
}

function orderTotal(lines: { quantity: unknown; unitPrice: unknown }[]): string {
  return lines.reduce((t, l) => t.add(D(l.quantity).mul(D(l.unitPrice))), D(0)).toDecimalPlaces(4).toString();
}

async function toView(o: PoRow, canSeeCost: boolean) {
  const received = await receivedQtyByLine(o.orgId, o.lines.map((l) => l.id));
  return {
    id: o.id,
    poNumber: o.poNumber,
    branchId: o.branchId,
    supplier: { id: o.supplier.id, name: o.supplier.name, status: o.supplier.status },
    status: o.status as PurchaseOrderStatus,
    currency: o.currency.trim(),
    requestedDeliveryDate: o.requestedDeliveryDate ? o.requestedDeliveryDate.toISOString().slice(0, 10) : null,
    supplierReference: o.supplierReference,
    notes: o.notes,
    ...(canSeeCost ? { total: orderTotal(o.lines) } : {}),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    lines: o.lines.map((l) => {
      const receivedQty = received.get(l.id) ?? D(0);
      const outstandingQty = D(l.quantity).sub(receivedQty);
      return {
        id: l.id,
        itemId: l.itemId,
        sku: l.item.sku,
        itemName: l.item.name,
        quantity: l.quantity.toString(),
        uom: l.uom,
        ...(canSeeCost ? { unitPrice: l.unitPrice.toString(), lineTotal: D(l.quantity).mul(D(l.unitPrice)).toDecimalPlaces(4).toString() } : {}),
        currency: l.currency.trim(),
        receivedQty: receivedQty.toString(),
        outstandingQty: (outstandingQty.lessThan(0) ? D(0) : outstandingQty).toString(),
      };
    }),
  };
}

async function validateRefs(session: AuthenticatedSession, refs: { supplierId?: string; currency?: string; itemIds?: string[] }) {
  if (refs.supplierId) {
    const supplier = await prisma.supplier.findFirst({ where: { orgId: session.orgId, id: refs.supplierId } });
    if (!supplier) throw new ValidationError("supplierId does not belong to this organization");
    if (supplier.status !== "active") throw new ValidationError("Cannot place a purchase order with an inactive supplier");
  }
  if (refs.currency) {
    const c = await prisma.currency.findUnique({ where: { code: refs.currency } });
    if (!c) throw new ValidationError(`Unknown currency code "${refs.currency}"`);
  }
  if (refs.itemIds) {
    const ids = [...new Set(refs.itemIds)];
    const items = await prisma.item.findMany({ where: { orgId: session.orgId, id: { in: ids } } });
    if (items.length !== ids.length) throw new ValidationError("One or more items do not belong to this organization");
    for (const it of items) {
      if (!it.isActive) throw new ValidationError(`Item ${it.sku} is inactive`);
      if (UNPURCHASABLE_ITEM_TYPES.has(it.itemType)) {
        throw new ValidationError(`Item ${it.sku} is a ${it.itemType.replace(/_/g, " ")} and can't be purchased -- it's produced, not bought in`);
      }
    }
  }
}

export async function createPurchaseOrder(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "purchase_order:create");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid purchase order", parsed.error.issues);
  const d = parsed.data;

  assertBranchAccess(session, d.branchId);
  const branch = await prisma.branch.findFirst({ where: { orgId: session.orgId, id: d.branchId } });
  if (!branch) throw new ValidationError("branchId does not belong to this organization");
  if (!branch.isActive) throw new ValidationError("Cannot create a purchase order for an inactive branch");
  await validateRefs(session, { supplierId: d.supplierId, currency: d.currency, itemIds: d.lines.map((l) => l.itemId) });

  const id = await prisma.$transaction(async (tx) => {
    // Serialise numbering per organisation, same pattern as sales-order-service.ts's
    // createSalesOrder: highest existing + 1 under an advisory lock held to the end of
    // this transaction, so concurrent creates cannot collide or skip.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"purchase_order_number:" + session.orgId}))`;
    const last = await tx.$queryRaw<{ n: number | null }[]>`
      SELECT MAX(substring(po_number from '^PO-([0-9]+)$')::int) AS n
        FROM purchase_order WHERE org_id = ${session.orgId}::uuid`;
    const poNumber = `PO-${String((last[0]?.n ?? 0) + 1).padStart(5, "0")}`;

    const po = await tx.purchaseOrder.create({
      data: {
        orgId: session.orgId,
        branchId: d.branchId,
        poNumber,
        supplierId: d.supplierId,
        currency: d.currency,
        status: "draft",
        requestedDeliveryDate: d.requestedDeliveryDate ? new Date(`${d.requestedDeliveryDate}T00:00:00Z`) : null,
        supplierReference: d.supplierReference ?? null,
        notes: d.notes ?? null,
        createdById: session.userId,
      },
    });
    await tx.purchaseOrderLine.createMany({
      data: d.lines.map((l) => ({
        orgId: session.orgId,
        poId: po.id,
        itemId: l.itemId,
        quantity: D(l.quantity),
        uom: l.uom,
        unitPrice: D(l.unitPrice),
        currency: d.currency,
      })),
    });
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: d.branchId,
      actorUserId: session.userId,
      entityType: "purchase_order",
      entityId: po.id,
      action: "create",
      afterValue: { poNumber, supplierId: d.supplierId, currency: d.currency, lineCount: d.lines.length },
    });
    return po.id;
  });
  return getPurchaseOrder(session, id);
}

export interface ListPurchaseOrdersFilter {
  status?: PurchaseOrderStatus;
  supplierId?: string;
  branchId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listPurchaseOrders(session: AuthenticatedSession, filter: ListPurchaseOrdersFilter = {}) {
  assertCapability(session.role, "purchase_order:read");
  if (filter.status && !(PURCHASE_ORDER_STATUS_VALUES as readonly string[]).includes(filter.status)) throw new ValidationError("Invalid status filter");
  const uuid = z.string().uuid();
  if (filter.branchId && !uuid.safeParse(filter.branchId).success) throw new ValidationError("Invalid branchId");
  if (filter.supplierId && !uuid.safeParse(filter.supplierId).success) throw new ValidationError("Invalid supplierId");
  if (filter.branchId) assertBranchAccess(session, filter.branchId);
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 25), 1), 100);
  const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
  const search = filter.search?.trim();

  const where: Prisma.PurchaseOrderWhereInput = {
    orgId: session.orgId,
    ...(filter.branchId ? { branchId: filter.branchId } : branchWhere(session)),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
    ...(search ? { OR: [{ poNumber: { contains: search, mode: "insensitive" } }, { supplier: { name: { contains: search, mode: "insensitive" } } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrder.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit, skip: offset }),
  ]);
  const canSeeCost = hasCapability(session.role, "cost:read");
  return { total, limit, offset, rows: await Promise.all(rows.map((r) => toView(r, canSeeCost))) };
}

export async function getPurchaseOrder(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "purchase_order:read");
  if (!z.string().uuid().safeParse(id).success) throw new NotFoundError("Purchase order");
  const po = await findPoInScope(session, id);
  if (!po) throw new NotFoundError("Purchase order");
  return toView(po, hasCapability(session.role, "cost:read"));
}

export async function updatePurchaseOrder(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "purchase_order:update");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid purchase order update", parsed.error.issues);
  const d = parsed.data;

  const existing = await findPoInScope(session, id);
  if (!existing) throw new NotFoundError("Purchase order");
  if (existing.status !== "draft") throw new ConflictError(`Only draft purchase orders can be edited; this one is "${existing.status.replace(/_/g, " ")}"`);
  await validateRefs(session, { supplierId: d.supplierId, itemIds: d.lines?.map((l) => l.itemId) });

  await prisma.$transaction(async (tx) => {
    // Re-check under the row's current state: another request may have confirmed it meanwhile.
    const cur = await tx.purchaseOrder.findFirst({ where: { orgId: session.orgId, id: existing.id }, select: { status: true } });
    if (!cur || cur.status !== "draft") throw new ConflictError("This purchase order is no longer a draft");
    await tx.purchaseOrder.update({
      where: { id: existing.id },
      data: {
        ...(d.supplierId ? { supplierId: d.supplierId } : {}),
        ...(d.requestedDeliveryDate !== undefined ? { requestedDeliveryDate: d.requestedDeliveryDate ? new Date(`${d.requestedDeliveryDate}T00:00:00Z`) : null } : {}),
        ...(d.supplierReference !== undefined ? { supplierReference: d.supplierReference } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
      },
    });
    if (d.lines) {
      // A draft PO can have no receipts yet (receiving requires confirmed -- see
      // goods-receipt-service.ts), so replacing lines wholesale is safe.
      await tx.purchaseOrderLine.deleteMany({ where: { orgId: session.orgId, poId: existing.id } });
      await tx.purchaseOrderLine.createMany({
        data: d.lines.map((l) => ({ orgId: session.orgId, poId: existing.id, itemId: l.itemId, quantity: D(l.quantity), uom: l.uom, unitPrice: D(l.unitPrice), currency: existing.currency })),
      });
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: existing.branchId,
      actorUserId: session.userId,
      entityType: "purchase_order",
      entityId: existing.id,
      action: "update",
      beforeValue: { supplierId: existing.supplierId, lineCount: existing.lines.length, total: orderTotal(existing.lines) },
      afterValue: {
        ...(d.supplierId ? { supplierId: d.supplierId } : {}),
        ...(d.lines ? { lineCount: d.lines.length, total: d.lines.reduce((t, l) => t.add(D(l.quantity).mul(D(l.unitPrice))), D(0)).toDecimalPlaces(4).toString() } : {}),
      },
    });
  });
  return getPurchaseOrder(session, id);
}

export async function confirmPurchaseOrder(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "purchase_order:confirm");
  const existing = await findPoInScope(session, id);
  if (!existing) throw new NotFoundError("Purchase order");
  if (existing.status === "confirmed") return getPurchaseOrder(session, id); // idempotent
  if (existing.status !== "draft") throw new ConflictError(`A "${existing.status.replace(/_/g, " ")}" purchase order can't be confirmed`);
  if (existing.lines.length === 0) throw new ConflictError("A purchase order with no lines can't be confirmed");
  await validateRefs(session, { supplierId: existing.supplierId, itemIds: existing.lines.map((l) => l.itemId) });

  await prisma.$transaction(async (tx) => {
    const res = await tx.purchaseOrder.updateMany({ where: { orgId: session.orgId, id: existing.id, status: "draft" }, data: { status: "confirmed" } });
    if (res.count !== 1) throw new ConflictError("This purchase order is no longer a draft");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: existing.branchId,
      actorUserId: session.userId,
      entityType: "purchase_order",
      entityId: existing.id,
      action: "transition",
      beforeValue: { status: "draft" },
      afterValue: { status: "confirmed" },
    });
  });
  return getPurchaseOrder(session, id);
}

export async function cancelPurchaseOrder(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "purchase_order:update");
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("A reason is required to cancel a purchase order", parsed.error.issues);

  const existing = await findPoInScope(session, id);
  if (!existing) throw new NotFoundError("Purchase order");
  if (existing.status === "cancelled") return getPurchaseOrder(session, id); // idempotent
  if (existing.status !== "draft" && existing.status !== "confirmed") {
    throw new ConflictError(`A "${existing.status.replace(/_/g, " ")}" purchase order can't be cancelled`);
  }

  await prisma.$transaction(async (tx) => {
    // Take the PO row FOR UPDATE first: a receipt being posted holds its own lock on the
    // same row's lines via the PO itself being read inside that transaction too (see
    // goods-receipt-service.ts), so either that receipt commits before we count (and
    // blocks the cancel) or it is posted after cancellation is already visible.
    await tx.$queryRaw`SELECT id FROM purchase_order WHERE id = ${existing.id}::uuid AND org_id = ${session.orgId}::uuid FOR UPDATE`;
    const receipts = await tx.goodsReceipt.count({ where: { orgId: session.orgId, poId: existing.id } });
    if (receipts > 0) throw new ConflictError("Goods have already been received against this purchase order; it can no longer be cancelled outright -- close it instead");
    const res = await tx.purchaseOrder.updateMany({ where: { orgId: session.orgId, id: existing.id, status: { in: ["draft", "confirmed"] } }, data: { status: "cancelled" } });
    if (res.count !== 1) throw new ConflictError("This purchase order can no longer be cancelled");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: existing.branchId,
      actorUserId: session.userId,
      entityType: "purchase_order",
      entityId: existing.id,
      action: "transition",
      beforeValue: { status: existing.status },
      afterValue: { status: "cancelled" },
      reason: parsed.data.reason,
    });
  });
  return getPurchaseOrder(session, id);
}

/** Manually closes a PO after receiving is done but the supplier will never deliver the remainder. */
export async function closePurchaseOrder(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "purchase_order:update");
  const parsed = closeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("A reason is required to close a purchase order", parsed.error.issues);

  const existing = await findPoInScope(session, id);
  if (!existing) throw new NotFoundError("Purchase order");
  if (existing.status === "closed") return getPurchaseOrder(session, id); // idempotent
  if (existing.status !== "confirmed" && existing.status !== "partially_received" && existing.status !== "received") {
    throw new ConflictError(`A "${existing.status.replace(/_/g, " ")}" purchase order can't be closed`);
  }

  await prisma.$transaction(async (tx) => {
    const res = await tx.purchaseOrder.updateMany({
      where: { orgId: session.orgId, id: existing.id, status: { in: ["confirmed", "partially_received", "received"] } },
      data: { status: "closed" },
    });
    if (res.count !== 1) throw new ConflictError("This purchase order can no longer be closed");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: existing.branchId,
      actorUserId: session.userId,
      entityType: "purchase_order",
      entityId: existing.id,
      action: "transition",
      beforeValue: { status: existing.status },
      afterValue: { status: "closed" },
      reason: parsed.data.reason,
    });
  });
  return getPurchaseOrder(session, id);
}

/** Purchase orders (with lines) for one supplier -- used by the supplier detail page. */
export async function listOrdersForSupplier(session: AuthenticatedSession, supplierId: string, limit = 10) {
  return listPurchaseOrders(session, { supplierId, limit });
}

// Internal helper re-exported for goods-receipt-service.ts, which needs the
// same "is this PO visible/receivable to this session" scoping rule and
// must not re-derive it independently.
export { findPoInScope, branchWhere };
