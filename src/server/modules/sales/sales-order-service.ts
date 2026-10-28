// Sales orders: the commercial record of what a customer asked for.
//
// Scope (deliberately narrow -- see docs/UI_IMPLEMENTATION_AUDIT.md):
//  - An order is created as a DRAFT, may be edited while draft, CONFIRMED, or CANCELLED.
//  - Creating or confirming an order NEVER creates production work. Work is released
//    separately, one job per order line, through createJob({ salesOrderLineId }) in the
//    production module (which requires a confirmed order).
//  - The schema also lists in_production / partially_delivered / delivered / closed, but no
//    fulfilment, delivery or invoicing model exists, so nothing here moves an order into
//    those states. That needs a business decision.
//  - One currency per order: every line carries the order's currency. Totals are a plain
//    quantity x unit price sum -- no tax, discount or rounding rule is invented.
//  - Orders are branch-scoped. An order in a branch the caller cannot access is reported as
//    "not found", never "forbidden".
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertBranchAccess, assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

export const SALES_ORDER_STATUS_VALUES = [
  "draft",
  "confirmed",
  "in_production",
  "partially_delivered",
  "delivered",
  "closed",
  "cancelled",
] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUS_VALUES)[number];

const D = (v: unknown) => new Prisma.Decimal(String(v));
const MAX_QTY = 1_000_000_000;
const MAX_PRICE = 9_999_999_999;

const hasAtMost4dp = (n: number) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6;

const lineSchema = z.object({
  itemId: z.string().uuid(),
  quantity: z.number().finite().positive("Quantity must be greater than zero").max(MAX_QTY).refine(hasAtMost4dp, "Quantity supports at most 4 decimal places"),
  unitPrice: z.number().finite().nonnegative("Unit price can't be negative").max(MAX_PRICE).refine(hasAtMost4dp, "Unit price supports at most 4 decimal places"),
});

const deliveryDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real date");

const createSchema = z.object({
  branchId: z.string().uuid(),
  customerId: z.string().uuid(),
  currency: z.string().trim().toUpperCase().length(3),
  requestedDeliveryDate: deliveryDateSchema.optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line").max(200),
});

const updateSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    requestedDeliveryDate: deliveryDateSchema.nullable().optional(),
    lines: z.array(lineSchema).min(1, "An order needs at least one line").max(200).optional(),
  })
  .refine((d) => d.customerId !== undefined || d.requestedDeliveryDate !== undefined || d.lines !== undefined, {
    message: "No fields supplied to update",
  });

const cancelSchema = z.object({ reason: z.string().trim().min(3, "Say why in at least 3 characters").max(500) });

type OrderRow = Prisma.SalesOrderGetPayload<{
  include: { lines: { include: { item: { select: { sku: true; name: true; uom: true } }; productionJob: { select: { id: true; jobNumber: true; status: true } } } }; customer: { select: { id: true; name: true } } };
}>;

function orderTotal(lines: { quantity: unknown; unitPrice: unknown }[]): string {
  return lines.reduce((t, l) => t.add(D(l.quantity).mul(D(l.unitPrice))), D(0)).toDecimalPlaces(4).toString();
}

function toView(o: OrderRow, canSeeJobs: boolean) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    branchId: o.branchId,
    customer: { id: o.customer.id, name: o.customer.name },
    status: o.status as SalesOrderStatus,
    currency: o.currency.trim(),
    requestedDeliveryDate: o.requestedDeliveryDate ? o.requestedDeliveryDate.toISOString().slice(0, 10) : null,
    total: orderTotal(o.lines),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    lines: o.lines.map((l) => ({
      id: l.id,
      itemId: l.itemId,
      sku: l.item.sku,
      itemName: l.item.name,
      uom: l.item.uom,
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      lineTotal: D(l.quantity).mul(D(l.unitPrice)).toDecimalPlaces(4).toString(),
      currency: l.currency.trim(),
      // Production linkage is only disclosed to callers who may read jobs.
      ...(canSeeJobs ? { productionJob: l.productionJob ? { id: l.productionJob.id, jobNumber: l.productionJob.jobNumber, status: l.productionJob.status } : null } : {}),
    })),
  };
}

const INCLUDE = {
  customer: { select: { id: true, name: true } },
  lines: {
    orderBy: { id: "asc" as const },
    include: { item: { select: { sku: true, name: true, uom: true } }, productionJob: { select: { id: true, jobNumber: true, status: true } } },
  },
} as const;

function branchWhere(session: AuthenticatedSession) {
  return session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } };
}

async function findOrderInScope(session: AuthenticatedSession, id: string) {
  const order = await prisma.salesOrder.findFirst({ where: { orgId: session.orgId, id, ...branchWhere(session) }, include: INCLUDE });
  return order;
}

/** Validates the pieces every create/update shares: customer, currency and sellable products. */
async function validateRefs(
  session: AuthenticatedSession,
  refs: { customerId?: string; currency?: string; itemIds?: string[] },
) {
  if (refs.customerId) {
    const customer = await prisma.customer.findFirst({ where: { orgId: session.orgId, id: refs.customerId } });
    if (!customer) throw new ValidationError("customerId does not belong to this organization");
    if (customer.status !== "active") throw new ValidationError("Cannot place an order for an inactive customer");
  }
  if (refs.currency) {
    const c = await prisma.currency.findUnique({ where: { code: refs.currency } });
    if (!c) throw new ValidationError(`Unknown currency code "${refs.currency}"`);
  }
  if (refs.itemIds) {
    const ids = [...new Set(refs.itemIds)];
    const items = await prisma.item.findMany({ where: { orgId: session.orgId, id: { in: ids } } });
    if (items.length !== ids.length) throw new ValidationError("One or more products do not belong to this organization");
    for (const it of items) {
      if (!it.isActive) throw new ValidationError(`Product ${it.sku} is inactive`);
      if (it.itemType !== "finished_good") throw new ValidationError(`Product ${it.sku} is not a finished good, so it can't be ordered`);
    }
  }
}

export async function createSalesOrder(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "sales_order:create");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid sales order", parsed.error.issues);
  const d = parsed.data;

  assertBranchAccess(session, d.branchId);
  const branch = await prisma.branch.findFirst({ where: { orgId: session.orgId, id: d.branchId } });
  if (!branch) throw new ValidationError("branchId does not belong to this organization");
  if (!branch.isActive) throw new ValidationError("Cannot create an order in an inactive branch");
  await validateRefs(session, { customerId: d.customerId, currency: d.currency, itemIds: d.lines.map((l) => l.itemId) });

  const id = await prisma.$transaction(async (tx) => {
    // Serialise numbering per organisation: number = highest existing + 1, under a lock held
    // to the end of this transaction, so concurrent creates cannot collide or skip.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sales_order_number:" + session.orgId}))`;
    const last = await tx.$queryRaw<{ n: number | null }[]>`
      SELECT MAX(substring(order_number from '^SO-([0-9]+)$')::int) AS n
        FROM sales_order WHERE org_id = ${session.orgId}::uuid`;
    const orderNumber = `SO-${String((last[0]?.n ?? 0) + 1).padStart(5, "0")}`;

    const order = await tx.salesOrder.create({
      data: {
        orgId: session.orgId,
        branchId: d.branchId,
        orderNumber,
        customerId: d.customerId,
        currency: d.currency,
        status: "draft",
        requestedDeliveryDate: d.requestedDeliveryDate ? new Date(`${d.requestedDeliveryDate}T00:00:00Z`) : null,
      },
    });
    await tx.salesOrderLine.createMany({
      data: d.lines.map((l) => ({ orgId: session.orgId, salesOrderId: order.id, itemId: l.itemId, quantity: D(l.quantity), unitPrice: D(l.unitPrice), currency: d.currency })),
    });
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: d.branchId,
      actorUserId: session.userId,
      entityType: "sales_order",
      entityId: order.id,
      action: "create",
      afterValue: { orderNumber, customerId: d.customerId, currency: d.currency, lineCount: d.lines.length },
    });
    return order.id;
  });
  return getSalesOrder(session, id);
}

export interface ListSalesOrdersFilter {
  status?: SalesOrderStatus;
  customerId?: string;
  branchId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listSalesOrders(session: AuthenticatedSession, filter: ListSalesOrdersFilter = {}) {
  assertCapability(session.role, "sales_order:read");
  if (filter.status && !(SALES_ORDER_STATUS_VALUES as readonly string[]).includes(filter.status)) throw new ValidationError("Invalid status filter");
  const uuid = z.string().uuid();
  if (filter.branchId && !uuid.safeParse(filter.branchId).success) throw new ValidationError("Invalid branchId");
  if (filter.customerId && !uuid.safeParse(filter.customerId).success) throw new ValidationError("Invalid customerId");
  if (filter.branchId) assertBranchAccess(session, filter.branchId);
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 25), 1), 100);
  const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
  const search = filter.search?.trim();

  const where: Prisma.SalesOrderWhereInput = {
    orgId: session.orgId,
    ...(filter.branchId ? { branchId: filter.branchId } : branchWhere(session)),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.customerId ? { customerId: filter.customerId } : {}),
    ...(search ? { OR: [{ orderNumber: { contains: search, mode: "insensitive" } }, { customer: { name: { contains: search, mode: "insensitive" } } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.salesOrder.count({ where }),
    prisma.salesOrder.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit, skip: offset }),
  ]);
  const canSeeJobs = hasCapability(session.role, "production_job:read");
  return { total, limit, offset, rows: rows.map((r) => toView(r, canSeeJobs)) };
}

export async function getSalesOrder(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "sales_order:read");
  if (!z.string().uuid().safeParse(id).success) throw new NotFoundError("Sales order");
  const order = await findOrderInScope(session, id);
  if (!order) throw new NotFoundError("Sales order");
  return toView(order, hasCapability(session.role, "production_job:read"));
}

export async function updateSalesOrder(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "sales_order:update");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid sales order update", parsed.error.issues);
  const d = parsed.data;

  const existing = await findOrderInScope(session, id);
  if (!existing) throw new NotFoundError("Sales order");
  if (existing.status !== "draft") throw new ConflictError(`Only draft orders can be edited; this order is "${existing.status.replace(/_/g, " ")}"`);
  await validateRefs(session, { customerId: d.customerId, itemIds: d.lines?.map((l) => l.itemId) });

  await prisma.$transaction(async (tx) => {
    // Re-check under the row's current state: another request may have confirmed it meanwhile.
    const cur = await tx.salesOrder.findFirst({ where: { orgId: session.orgId, id: existing.id }, select: { status: true } });
    if (!cur || cur.status !== "draft") throw new ConflictError("This order is no longer a draft");
    await tx.salesOrder.update({
      where: { id: existing.id },
      data: {
        ...(d.customerId ? { customerId: d.customerId } : {}),
        ...(d.requestedDeliveryDate !== undefined ? { requestedDeliveryDate: d.requestedDeliveryDate ? new Date(`${d.requestedDeliveryDate}T00:00:00Z`) : null } : {}),
      },
    });
    if (d.lines) {
      // A draft order cannot have jobs (jobs need a confirmed order), so replacing lines is safe.
      await tx.salesOrderLine.deleteMany({ where: { orgId: session.orgId, salesOrderId: existing.id } });
      await tx.salesOrderLine.createMany({
        data: d.lines.map((l) => ({ orgId: session.orgId, salesOrderId: existing.id, itemId: l.itemId, quantity: D(l.quantity), unitPrice: D(l.unitPrice), currency: existing.currency })),
      });
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: existing.branchId,
      actorUserId: session.userId,
      entityType: "sales_order",
      entityId: existing.id,
      action: "update",
      beforeValue: { customerId: existing.customerId, requestedDeliveryDate: existing.requestedDeliveryDate?.toISOString().slice(0, 10) ?? null, lineCount: existing.lines.length, total: orderTotal(existing.lines) },
      afterValue: {
        ...(d.customerId ? { customerId: d.customerId } : {}),
        ...(d.requestedDeliveryDate !== undefined ? { requestedDeliveryDate: d.requestedDeliveryDate } : {}),
        ...(d.lines ? { lineCount: d.lines.length, total: d.lines.reduce((t, l) => t.add(D(l.quantity).mul(D(l.unitPrice))), D(0)).toDecimalPlaces(4).toString() } : {}),
      },
    });
  });
  return getSalesOrder(session, id);
}

export async function confirmSalesOrder(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "sales_order:confirm");
  const existing = await findOrderInScope(session, id);
  if (!existing) throw new NotFoundError("Sales order");
  if (existing.status === "confirmed") return getSalesOrder(session, id); // idempotent
  if (existing.status !== "draft") throw new ConflictError(`A "${existing.status.replace(/_/g, " ")}" order can't be confirmed`);
  if (existing.lines.length === 0) throw new ConflictError("An order with no lines can't be confirmed");
  // Re-validate what could have changed since the draft was written.
  await validateRefs(session, { customerId: existing.customerId, itemIds: existing.lines.map((l) => l.itemId) });

  await prisma.$transaction(async (tx) => {
    const res = await tx.salesOrder.updateMany({ where: { orgId: session.orgId, id: existing.id, status: "draft" }, data: { status: "confirmed" } });
    if (res.count !== 1) throw new ConflictError("This order is no longer a draft");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: existing.branchId,
      actorUserId: session.userId,
      entityType: "sales_order",
      entityId: existing.id,
      action: "transition",
      beforeValue: { status: "draft" },
      afterValue: { status: "confirmed" },
    });
  });
  return getSalesOrder(session, id);
}

export async function cancelSalesOrder(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "sales_order:update");
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("A reason is required to cancel an order", parsed.error.issues);

  const existing = await findOrderInScope(session, id);
  if (!existing) throw new NotFoundError("Sales order");
  if (existing.status === "cancelled") return getSalesOrder(session, id); // idempotent
  if (existing.status !== "draft" && existing.status !== "confirmed") {
    throw new ConflictError(`A "${existing.status.replace(/_/g, " ")}" order can't be cancelled`);
  }
  // Work already released against the order must be dealt with on the job first.
  const live = existing.lines.filter((l) => l.productionJob && l.productionJob.status !== "cancelled");
  if (live.length > 0) {
    throw new ConflictError(`Cancel the linked production job${live.length > 1 ? "s" : ""} first (${live.map((l) => l.productionJob!.jobNumber).join(", ")})`);
  }

  await prisma.$transaction(async (tx) => {
    // Take the order row FOR UPDATE first: a job being released holds it FOR SHARE, so either
    // that job commits before we count (and blocks the cancel) or it sees "cancelled".
    await tx.$queryRaw`SELECT id FROM sales_order WHERE id = ${existing.id}::uuid AND org_id = ${session.orgId}::uuid FOR UPDATE`;
    const jobs = await tx.productionJob.count({ where: { orgId: session.orgId, salesOrderLine: { salesOrderId: existing.id }, status: { not: "cancelled" } } });
    if (jobs > 0) throw new ConflictError("A production job was linked to this order; cancel it first");
    const res = await tx.salesOrder.updateMany({ where: { orgId: session.orgId, id: existing.id, status: { in: ["draft", "confirmed"] } }, data: { status: "cancelled" } });
    if (res.count !== 1) throw new ConflictError("This order can no longer be cancelled");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: existing.branchId,
      actorUserId: session.userId,
      entityType: "sales_order",
      entityId: existing.id,
      action: "transition",
      beforeValue: { status: existing.status },
      afterValue: { status: "cancelled" },
      reason: parsed.data.reason,
    });
  });
  return getSalesOrder(session, id);
}

/** Orders (with their lines and linked jobs) for one customer -- used by the customer page. */
export async function listOrdersForCustomer(session: AuthenticatedSession, customerId: string, limit = 10) {
  return listSalesOrders(session, { customerId, limit });
}
