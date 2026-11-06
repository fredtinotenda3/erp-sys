// Dispatch and Delivery (Milestone 3): fulfilling a confirmed sales order by
// shipping finished-goods stock to the customer, and recording confirmation
// that it arrived.
//
// Two distinct events, kept deliberately separate (see
// prisma/schema.prisma's comment above the Dispatch model for the data-
// model side of this):
//  - createDispatch is the inventory-integrity event. It posts ONE
//    StockMovement (movement_type = sale_delivery, negative) per finished-
//    goods batch drawn from, through the single canonical insert path
//    (stock-core.ts), debits that batch's own ledger (FgBatchMovement,
//    type = dispatch) in the SAME transaction, and recomputes the
//    SalesOrder's status from cumulative dispatched quantity vs. ordered
//    quantity. Only `active` finished-goods batches are eligible --
//    quarantined and rejected batches are refused outright: shipping
//    unreleased or defective stock to a customer is a quality escape this
//    file does not allow, not merely discourage (stricter than
//    transferBatch, which does allow moving quarantined stock between
//    warehouses -- a location change is not a release-for-use).
//  - confirmDelivery is a proof-of-delivery record (who received it, when,
//    any notes). Purely informational: it moves no stock and does not
//    change the SalesOrder's status, which is already driven by what
//    shipped. See the schema comment for why "delivered" is read as
//    "fully shipped," not "customer has signed for it" -- a deliberate,
//    documented reading of an enum this milestone did not get to redesign.
//
// PICKING: a dispatch line's quantity is drawn from eligible batches either
// by the caller's explicit `batchAllocations` or by auto-allocation, oldest
// batch first (FIFO by producedAt) -- finished-goods batches carry no
// expiry concept, so FIFO is the direct analog of material-issue-service.ts's
// FEFO-for-raw-materials default. Candidates for every distinct item used in
// this dispatch are locked (pg_advisory_xact_lock, same key -- 19 -- that
// transferBatch/adjustBatch already use per batch, so a dispatch can never
// race a concurrent transfer or adjustment of the same batch) before any
// remaining figure is read, exactly mirroring lot-availability.ts's
// lockLots pattern.
//
// SCOPE DECISIONS NOT BUILT HERE (see IMPLEMENTATION_MANIFEST.md Milestone 3
// for the full reasoning):
//  - No sales return / credit note flow. A Dispatch, once created, cannot
//    be reversed or cancelled -- only its delivery-confirmation columns are
//    ever mutated. Shipping the wrong thing is corrected the same way a
//    wrong goods receipt would be: by a manual stock adjustment against the
//    affected finished-goods batch (adjustBatch), with a reason recorded,
//    not by deleting or editing the dispatch record itself.
//  - No partial-batch-pick UI exposure of batchAllocations is assumed by
//    the frontend (it lets the service auto-allocate), but the API itself
//    accepts explicit allocations, same "optional override, default
//    auto-allocate" shape material-issue-service.ts's lotAllocations uses.
//  - No carrier/freight integration, no packing-list/pallet model, no
//    partial-line split-shipment UI beyond what multiple dispatches against
//    the same order already give for free (dispatch 1 ships half a line,
//    dispatch 2 ships the rest -- both are ordinary creates).
//  - No invoicing. COGS shown on a dispatch's detail view (gated by
//    cost:read) is informational -- resolved live from the same batch cost
//    lines Milestone 2 already made immutable -- never a journal entry.
import { randomUUID } from "crypto";
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findOrderInScope } from "../sales/sales-order-service";
import { findWarehouseInScope } from "./warehouse-service";
import { postMovementInTransaction } from "./stock-core";
import { isBalanceCreationRace, mapStockTriggerError } from "./stock-errors";
import { remainingOfBatch, resolveCostLines } from "./finished-goods-service";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const MAX_QTY = 1_000_000_000;
const hasAtMost4dp = (n: number) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6;

const positiveQty = z.number().finite().positive().max(MAX_QTY).refine(hasAtMost4dp, "quantity supports at most 4 decimal places");
const occurredAtSchema = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, "cannot be in the future")
  .optional();

// Dispatching is only meaningful once the order is a real commitment
// (confirmed) and while there is still something outstanding. "in_production"
// is included defensively even though nothing in this codebase sets that
// status today (sales-order-service.ts's own header comment flags this as
// an unresolved pre-existing gap, not something this milestone resolves) --
// logically it sits between "confirmed" and "delivered", so a dispatch
// should not be blocked if some later change starts using it.
const DISPATCHABLE_ORDER_STATUSES = new Set(["confirmed", "in_production", "partially_delivered"]);

const batchAllocationSchema = z.object({ batchId: z.string().uuid(), quantity: positiveQty });

const lineSchema = z.object({
  salesOrderLineId: z.string().uuid(),
  quantity: positiveQty,
  // Omit to auto-allocate FIFO (oldest produced first) across whatever
  // active finished-goods batches this item has in the dispatch's
  // warehouse. Required to name specific batches instead; see file header.
  batchAllocations: z.array(batchAllocationSchema).min(1).max(50).optional(),
});

const createSchema = z.object({
  clientRequestId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  dispatchedAt: occurredAtSchema,
  carrier: z.string().trim().max(100).optional(),
  trackingReference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line").max(100),
});

const deliverSchema = z.object({
  deliveredAt: occurredAtSchema,
  receivedBy: z.string().trim().max(200).optional(),
  deliveryNotes: z.string().trim().max(1000).optional(),
});

function branchWhere(session: AuthenticatedSession) {
  return session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } };
}

type DispatchRow = Prisma.DispatchGetPayload<{
  include: {
    salesOrder: { select: { id: true; orderNumber: true; customer: { select: { id: true; name: true } } } };
    warehouse: { select: { id: true; name: true } };
    lines: {
      include: {
        salesOrderLine: { select: { id: true; itemId: true; item: { select: { sku: true; name: true } } } };
        batchAllocations: { include: { batch: { select: { id: true; batchNumber: true; goodQty: true; transferredFromBatchId: true } } } };
      };
    };
  };
}>;

const DISPATCH_INCLUDE = {
  salesOrder: { select: { id: true, orderNumber: true, customer: { select: { id: true, name: true } } } },
  warehouse: { select: { id: true, name: true } },
  lines: {
    orderBy: { id: "asc" as const },
    include: {
      salesOrderLine: { select: { id: true, itemId: true, item: { select: { sku: true, name: true } } } },
      batchAllocations: { include: { batch: { select: { id: true, batchNumber: true, goodQty: true, transferredFromBatchId: true } } }, orderBy: { createdAt: "asc" as const } },
    },
  },
} as const;

async function toDispatchView(row: DispatchRow, showCost: boolean) {
  const costByCurrency = new Map<string, Prisma.Decimal>();
  if (showCost) {
    const resolvedByBatch = new Map<string, { perUnit: Prisma.Decimal; currency: string }[]>();
    for (const line of row.lines) {
      for (const a of line.batchAllocations) {
        if (!resolvedByBatch.has(a.batch.id)) {
          const lines = await resolveCostLines(prisma, row.orgId, a.batch);
          const goodQty = D(a.batch.goodQty);
          resolvedByBatch.set(
            a.batch.id,
            lines.map((l) => ({ currency: l.currency, perUnit: goodQty.greaterThan(0) ? D(l.materialCost).add(D(l.labourCost ?? 0)).div(goodQty) : D(0) })),
          );
        }
        for (const r of resolvedByBatch.get(a.batch.id)!) {
          const cost = r.perUnit.mul(D(a.quantity));
          costByCurrency.set(r.currency, (costByCurrency.get(r.currency) ?? D(0)).add(cost));
        }
      }
    }
  }

  return {
    id: row.id,
    dispatchNumber: row.dispatchNumber,
    branchId: row.branchId,
    status: row.status,
    salesOrderId: row.salesOrder.id,
    orderNumber: row.salesOrder.orderNumber,
    customer: { id: row.salesOrder.customer.id, name: row.salesOrder.customer.name },
    warehouseId: row.warehouse.id,
    warehouseName: row.warehouse.name,
    dispatchedAt: row.dispatchedAt,
    carrier: row.carrier,
    trackingReference: row.trackingReference,
    notes: row.notes,
    deliveredAt: row.deliveredAt,
    receivedBy: row.receivedBy,
    deliveryNotes: row.deliveryNotes,
    createdAt: row.createdAt,
    lines: row.lines.map((l) => ({
      id: l.id,
      salesOrderLineId: l.salesOrderLineId,
      itemId: l.salesOrderLine.itemId,
      sku: l.salesOrderLine.item.sku,
      itemName: l.salesOrderLine.item.name,
      quantity: l.quantity.toString(),
      uom: l.uom,
      batchAllocations: l.batchAllocations.map((a) => ({ batchId: a.batch.id, batchNumber: a.batch.batchNumber, quantity: a.quantity.toString() })),
    })),
    ...(showCost
      ? {
          costOfGoodsDispatched: [...costByCurrency.entries()].map(([currency, amount]) => ({ currency, amount: amount.toDecimalPlaces(4).toString() })),
          costNote: "Informational valuation resolved live from each batch's own (immutable) cost basis -- not a general-ledger posting.",
        }
      : {}),
  };
}

async function findDispatchInScope(session: AuthenticatedSession, id: string): Promise<DispatchRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return prisma.dispatch.findFirst({ where: { orgId: session.orgId, id, ...branchWhere(session) }, include: DISPATCH_INCLUDE });
}

export async function getDispatch(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "dispatch:read");
  const row = await findDispatchInScope(session, id);
  if (!row) throw new NotFoundError("Dispatch");
  return toDispatchView(row, hasCapability(session.role, "cost:read"));
}

export interface ListDispatchesFilter {
  salesOrderId?: string;
  warehouseId?: string;
  status?: "dispatched" | "delivered";
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listDispatches(session: AuthenticatedSession, filter: ListDispatchesFilter = {}) {
  assertCapability(session.role, "dispatch:read");
  const uuid = z.string().uuid();
  if (filter.salesOrderId && !uuid.safeParse(filter.salesOrderId).success) throw new ValidationError("Invalid salesOrderId");
  if (filter.warehouseId && !uuid.safeParse(filter.warehouseId).success) throw new ValidationError("Invalid warehouseId");
  if (filter.status && filter.status !== "dispatched" && filter.status !== "delivered") throw new ValidationError("Invalid status filter");
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 25), 1), 100);
  const offset = Math.max(Math.trunc(filter.offset ?? 0), 0);
  const search = filter.search?.trim();

  const where: Prisma.DispatchWhereInput = {
    orgId: session.orgId,
    ...branchWhere(session),
    ...(filter.salesOrderId ? { salesOrderId: filter.salesOrderId } : {}),
    ...(filter.warehouseId ? { warehouseId: filter.warehouseId } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(search ? { OR: [{ dispatchNumber: { contains: search, mode: "insensitive" } }, { salesOrder: { orderNumber: { contains: search, mode: "insensitive" } } }, { salesOrder: { customer: { name: { contains: search, mode: "insensitive" } } } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.dispatch.count({ where }),
    prisma.dispatch.findMany({ where, include: DISPATCH_INCLUDE, orderBy: [{ dispatchedAt: "desc" }, { id: "desc" }], take: limit, skip: offset }),
  ]);
  const showCost = hasCapability(session.role, "cost:read");
  return { total, limit, offset, rows: await Promise.all(rows.map((r) => toDispatchView(r, showCost))) };
}

/** Dispatches (with lines) for one sales order -- used by the order detail page. */
export async function listDispatchesForOrder(session: AuthenticatedSession, salesOrderId: string) {
  assertCapability(session.role, "dispatch:read");
  const order = await findOrderInScope(session, salesOrderId);
  if (!order) throw new NotFoundError("Sales order");
  const showCost = hasCapability(session.role, "cost:read");
  const rows = await prisma.dispatch.findMany({ where: { orgId: session.orgId, salesOrderId }, include: DISPATCH_INCLUDE, orderBy: [{ dispatchedAt: "desc" }, { id: "desc" }] });
  return Promise.all(rows.map((r) => toDispatchView(r, showCost)));
}

interface BatchCandidate {
  id: string;
  batchNumber: string;
  goodQty: Prisma.Decimal;
  uom: string;
  producedAt: Date;
}

/**
 * Records a dispatch against a confirmed (or later) sales order: one or
 * more lines, each picked from eligible finished-goods batches in the
 * chosen warehouse, posted to stock, and the order's status recomputed.
 * See the file header for the governing design decisions.
 */
export async function createDispatch(session: AuthenticatedSession, salesOrderId: string, input: unknown) {
  assertCapability(session.role, "dispatch:create");
  if (!z.string().uuid().safeParse(salesOrderId).success) throw new NotFoundError("Sales order");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid dispatch", parsed.error.issues);
  const d = parsed.data;

  // Header-level idempotency, checked before the transaction. Dispatch
  // itself has no clientRequestId column -- a composite, multi-insert
  // operation like this one (potentially several StockMovement rows, one
  // per batch allocation) keys its idempotency on the FIRST such movement's
  // clientRequestId instead, the same "one request, one ledger entry rides
  // the whole operation's idempotency" pattern transferBatch uses for its
  // own outMovement.
  const existingMovement = await prisma.stockMovement.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (existingMovement) {
    const allocation = await prisma.dispatchBatchAllocation.findFirst({
      where: { orgId: session.orgId, fgBatchMovement: { movementId: existingMovement.id } },
      include: { dispatchLine: { select: { dispatchId: true } } },
    });
    if (!allocation) throw new ConflictError("clientRequestId was already used for a different request");
    return { replayed: true, dispatch: await getDispatch(session, allocation.dispatchLine.dispatchId) };
  }

  const order = await findOrderInScope(session, salesOrderId);
  if (!order) throw new NotFoundError("Sales order");
  if (!DISPATCHABLE_ORDER_STATUSES.has(order.status)) {
    throw new ConflictError(`A "${order.status.replace(/_/g, " ")}" order cannot be dispatched`);
  }

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");
  if (!warehouse.isActive) throw new ValidationError("Cannot dispatch from an inactive warehouse");
  if (warehouse.branchId !== order.branchId) throw new ValidationError("The dispatch warehouse must be in the same branch as the order");

  const orderLineById = new Map(order.lines.map((l) => [l.id, l]));
  for (const line of d.lines) {
    if (!orderLineById.has(line.salesOrderLineId)) throw new ValidationError(`salesOrderLineId ${line.salesOrderLineId} does not belong to this order`);
  }
  // Merge duplicate salesOrderLineId submissions so the over-dispatch check
  // below sees the combined effect of this whole submission.
  const requestedByLine = new Map<string, Prisma.Decimal>();
  for (const line of d.lines) requestedByLine.set(line.salesOrderLineId, (requestedByLine.get(line.salesOrderLineId) ?? D(0)).add(D(line.quantity)));

  const dispatchedAtValue = d.dispatchedAt ?? new Date();
  let dispatchId: string;
  try {
    dispatchId = await prisma.$transaction(async (tx) => {
      // Lock the order row for the rest of this transaction: two concurrent
      // dispatches against the same order must serialise here, otherwise
      // both could read the same "already dispatched" totals and together
      // ship more than was ordered. Same lock cancelSalesOrder takes, for
      // the same reason.
      await tx.$queryRaw`SELECT id FROM sales_order WHERE id = ${order.id}::uuid AND org_id = ${session.orgId}::uuid FOR UPDATE`;

      const freshLines = await tx.salesOrderLine.findMany({ where: { orgId: session.orgId, salesOrderId: order.id } });
      const alreadyDispatched = await tx.dispatchLine.groupBy({ by: ["salesOrderLineId"], where: { orgId: session.orgId, salesOrderLineId: { in: freshLines.map((l) => l.id) } }, _sum: { quantity: true } });
      const dispatchedSoFar = new Map(alreadyDispatched.map((r) => [r.salesOrderLineId, D(r._sum.quantity ?? 0)]));
      for (const fl of freshLines) {
        const additional = requestedByLine.get(fl.id);
        if (!additional || additional.equals(0)) continue;
        const already = dispatchedSoFar.get(fl.id) ?? D(0);
        const ordered = D(fl.quantity);
        if (already.add(additional).greaterThan(ordered)) {
          const outstanding = Prisma.Decimal.max(ordered.sub(already), 0);
          throw new ConflictError(`Dispatching ${additional.toString()} more of this line would exceed the ordered quantity -- only ${outstanding.toString()} remains outstanding`);
        }
      }

      // Lock every distinct item's full set of ACTIVE finished-goods
      // batches in this warehouse, up front, before any remaining figure
      // is read -- see lot-availability.ts's lockLots for why (concurrent
      // dispatches/transfers/adjustments against the same batch must
      // serialise, not just read-then-write). The same advisory lock key
      // (19) transferBatch/adjustBatch already use per batch, so this
      // dispatch, a concurrent transfer and a concurrent adjustment of the
      // same batch can never race each other either.
      const itemIds = [...new Set(d.lines.map((l) => orderLineById.get(l.salesOrderLineId)!.itemId))];
      const candidatesByItem = new Map<string, BatchCandidate[]>();
      const remainingByBatch = new Map<string, Prisma.Decimal>();
      for (const itemId of itemIds) {
        const candidates = await tx.finishedGoodsBatch.findMany({
          where: { orgId: session.orgId, productItemId: itemId, warehouseId: warehouse.id, status: "active" },
          select: { id: true, batchNumber: true, goodQty: true, uom: true, producedAt: true },
          orderBy: { producedAt: "asc" },
        });
        candidatesByItem.set(itemId, candidates);
        const sortedIds = [...candidates.map((c) => c.id)].sort();
        for (const id of sortedIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 19))`;
        for (const c of candidates) remainingByBatch.set(c.id, await remainingOfBatch(tx, session.orgId, c.id, D(c.goodQty)));
      }

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"dispatch_number:" + session.orgId}))`;
      const last = await tx.$queryRaw<{ n: number | null }[]>`
        SELECT MAX(substring(dispatch_number from '^DN-([0-9]+)$')::int) AS n
          FROM dispatch WHERE org_id = ${session.orgId}::uuid`;
      const dispatchNumber = `DN-${String((last[0]?.n ?? 0) + 1).padStart(6, "0")}`;

      const dispatch = await tx.dispatch.create({
        data: {
          orgId: session.orgId,
          branchId: order.branchId,
          dispatchNumber,
          salesOrderId: order.id,
          warehouseId: warehouse.id,
          dispatchedAt: dispatchedAtValue,
          carrier: d.carrier ?? null,
          trackingReference: d.trackingReference ?? null,
          notes: d.notes ?? null,
          createdById: session.userId,
        },
      });

      // Exactly one movement across this ENTIRE dispatch (the first batch
      // allocation of the first line) carries the caller's own
      // clientRequestId -- the whole-submission idempotency gate checked
      // above before this transaction even opened. Every other movement
      // gets a fresh, server-generated id.
      let primaryClientRequestIdUsed = false;
      for (const line of d.lines) {
        const orderLine = orderLineById.get(line.salesOrderLineId)!;
        const candidates = candidatesByItem.get(orderLine.itemId)!;
        const uom = orderLine.item.uom;

        let allocations: { batchId: string; quantity: Prisma.Decimal }[];
        if (line.batchAllocations && line.batchAllocations.length > 0) {
          const sum = line.batchAllocations.reduce((s, a) => s.add(D(a.quantity)), D(0));
          if (!sum.equals(D(line.quantity))) throw new ValidationError(`batchAllocations must sum exactly to the dispatched quantity (${line.quantity} ${uom})`);
          const seen = new Set<string>();
          allocations = line.batchAllocations.map((a) => {
            if (seen.has(a.batchId)) throw new ValidationError("Each batch can only appear once in batchAllocations");
            seen.add(a.batchId);
            const candidate = candidates.find((c) => c.id === a.batchId);
            if (!candidate) throw new ValidationError(`batchId ${a.batchId} is not an active finished-goods batch of this item in this warehouse`);
            const rem = remainingByBatch.get(a.batchId) ?? D(0);
            const qty = D(a.quantity);
            if (qty.greaterThan(rem)) throw new ValidationError(`Batch ${candidate.batchNumber} only has ${rem.toString()} ${candidate.uom} remaining -- cannot dispatch ${qty.toString()}`);
            return { batchId: a.batchId, quantity: qty };
          });
        } else {
          // Auto FIFO: oldest produced first.
          let need = D(line.quantity);
          allocations = [];
          for (const candidate of candidates) {
            if (need.lessThanOrEqualTo(0)) break;
            const rem = remainingByBatch.get(candidate.id) ?? D(0);
            if (rem.lessThanOrEqualTo(0)) continue;
            const take = Prisma.Decimal.min(need, rem);
            allocations.push({ batchId: candidate.id, quantity: take });
            need = need.sub(take);
          }
          if (need.greaterThan(0)) {
            const totalAvailable = [...candidates.map((c) => remainingByBatch.get(c.id) ?? D(0))].reduce((s, r) => s.add(Prisma.Decimal.max(r, 0)), D(0));
            throw new ValidationError(
              `Insufficient active finished-goods stock for ${orderLine.item.name} in this warehouse: ${need.toString()} ${uom} short (only ${totalAvailable.toString()} ${uom} available across ${candidates.length} batch(es))`,
            );
          }
        }

        const dispatchLine = await tx.dispatchLine.create({
          data: { orgId: session.orgId, dispatchId: dispatch.id, salesOrderLineId: orderLine.id, quantity: D(line.quantity), uom },
        });

        for (const a of allocations) {
          // Decrement the shared, in-memory remaining map so a LATER line
          // in this same dispatch that draws from the same batch (two
          // lines of the same item) never reads a stale, pre-consumption
          // figure.
          remainingByBatch.set(a.batchId, (remainingByBatch.get(a.batchId) ?? D(0)).sub(a.quantity));

          await postMovementInTransaction(tx, session, {
            warehouse: { id: warehouse.id, branchId: warehouse.branchId },
            itemId: orderLine.itemId,
            movementType: "sale_delivery",
            quantity: a.quantity.neg(),
            unitCost: null, // the trigger stamps the warehouse's current average
            currency: null,
            referenceType: "sales_order",
            referenceId: order.id,
            reason: d.notes ?? `Dispatch ${dispatchNumber}`,
            // One real stock movement per batch allocation (FgBatchMovement
            // is 1:1 with a StockMovement, same discipline as transfer/
            // adjust) -- each gets its own fresh id, except the very first
            // one across the whole dispatch (see the flag above).
            clientRequestId: primaryClientRequestIdUsed ? randomUUID() : d.clientRequestId,
            occurredAt: dispatchedAtValue,
            afterInsert: async (innerTx, m) => {
              const fgMovement = await innerTx.fgBatchMovement.create({
                data: { orgId: session.orgId, batchId: a.batchId, movementId: m.id, type: "dispatch", quantity: a.quantity.neg(), reason: d.notes ?? null, createdById: session.userId },
              });
              await innerTx.dispatchBatchAllocation.create({
                data: { orgId: session.orgId, dispatchLineId: dispatchLine.id, batchId: a.batchId, fgBatchMovementId: fgMovement.id, quantity: a.quantity },
              });
            },
          });
          primaryClientRequestIdUsed = true;
        }
      }

      // Recompute the order's status from the now-complete picture (this
      // dispatch's own lines included -- read-your-writes within this
      // transaction), across EVERY line of the order, not just the ones
      // this dispatch touched.
      const totals = await tx.dispatchLine.groupBy({ by: ["salesOrderLineId"], where: { orgId: session.orgId, salesOrderLineId: { in: freshLines.map((l) => l.id) } }, _sum: { quantity: true } });
      const dispatchedTotal = new Map(totals.map((r) => [r.salesOrderLineId, D(r._sum.quantity ?? 0)]));
      let anyDispatched = false;
      let allComplete = true;
      for (const fl of freshLines) {
        const disp = dispatchedTotal.get(fl.id) ?? D(0);
        if (disp.greaterThan(0)) anyDispatched = true;
        if (disp.lessThan(D(fl.quantity))) allComplete = false;
      }
      const newStatus = allComplete ? "delivered" : anyDispatched ? "partially_delivered" : order.status;
      if (newStatus !== order.status) {
        await tx.salesOrder.update({ where: { id: order.id }, data: { status: newStatus } });
      }

      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: order.branchId,
        actorUserId: session.userId,
        entityType: "dispatch",
        entityId: dispatch.id,
        action: "create",
        afterValue: { salesOrderId: order.id, dispatchNumber, warehouseId: warehouse.id, lineCount: d.lines.length },
      });

      return dispatch.id;
    });
  } catch (err) {
    if (isBalanceCreationRace(err)) {
      throw new ConflictError("A concurrent stock update collided with this dispatch; please retry the request");
    }
    throw mapStockTriggerError(err);
  }

  return { replayed: false, dispatch: await getDispatch(session, dispatchId) };
}

/**
 * Records that a dispatch was received by the customer. Purely
 * informational -- see the file header for why this never moves stock or
 * changes the sales order's status.
 */
export async function confirmDelivery(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "dispatch:create");
  const parsed = deliverSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid delivery confirmation", parsed.error.issues);
  const d = parsed.data;

  const dispatch = await findDispatchInScope(session, id);
  if (!dispatch) throw new NotFoundError("Dispatch");
  if (dispatch.status === "delivered") return getDispatch(session, id); // idempotent

  const deliveredAtValue = d.deliveredAt ?? new Date();
  await prisma.$transaction(async (tx) => {
    const res = await tx.dispatch.updateMany({
      where: { orgId: session.orgId, id: dispatch.id, status: "dispatched" },
      data: { status: "delivered", deliveredAt: deliveredAtValue, receivedBy: d.receivedBy ?? null, deliveryNotes: d.deliveryNotes ?? null },
    });
    if (res.count !== 1) throw new ConflictError("This dispatch's delivery was already recorded");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: dispatch.branchId,
      actorUserId: session.userId,
      entityType: "dispatch",
      entityId: dispatch.id,
      action: "transition",
      beforeValue: { status: "dispatched" },
      afterValue: { status: "delivered", receivedBy: d.receivedBy ?? null },
    });
  });
  return getDispatch(session, id);
}
