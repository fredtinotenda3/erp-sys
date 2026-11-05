// Goods Receiving: records what actually arrived against a confirmed
// purchase order, inspects it (accepted/rejected -- the same shape
// quality-service.ts already uses for production inspections), posts the
// accepted quantity into stock through the ONE stock-movement code path
// (stock-core.ts's postMovementInTransaction), and creates the incoming
// half of lot traceability (one MaterialLot per accepted line -- see
// prisma/schema.prisma's comment above the MaterialLot model for the full
// chain and what is / isn't built yet: consumption, finished-goods batches
// and dispatch traceability are explicitly out of scope here).
//
// Design decisions worth restating here (full rationale in schema.prisma
// and IMPLEMENTATION_MANIFEST.md -- this file implements them, not
// re-derives them):
//  - One idempotency key per WHOLE submission (GoodsReceipt.clientRequestId),
//    not per line: a UI retry resubmits the entire delivery note once, not
//    line-by-line. Individual StockMovement/MaterialLot rows created by a
//    receipt get their own fresh, server-generated ids -- the header check
//    already prevents the creating code from running twice.
//  - Over-ACCEPTING beyond a line's ordered quantity is hard-blocked, with
//    no authorised-exception override in this milestone (the mandate
//    allows one; building the approval workflow for it is a business
//    decision this file does not make on its own -- see
//    IMPLEMENTATION_MANIFEST.md). Physically receiving/rejecting more than
//    was ordered is NOT blocked: a real delivery can over-ship and have the
//    excess rejected at inspection, which is a legitimate receiving note,
//    not an error. Only cumulative ACCEPTED quantity is bounded by the
//    ordered quantity, because accepted quantity is what actually enters
//    inventory and fulfils the order.
//  - unitCost/currency always come from the PO line, never the client --
//    same rule every other inventory-affecting endpoint in this codebase
//    follows for cost data.
//  - The whole submission (header + every line's GoodsReceiptLine +
//    StockMovement + MaterialLot + the PO's resulting status) commits or
//    rolls back together as one transaction -- see stock-core.ts's
//    postMovementInTransaction for why postMovement itself (which always
//    opens its own transaction against the pooled client) cannot be reused
//    unmodified for a multi-insert composite operation like this one.
import { randomUUID } from "crypto";
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { REJECT_REASONS } from "../production/output-service";
import { postMovementInTransaction } from "../inventory/stock-core";
import { isBalanceCreationRace, mapStockTriggerError } from "../inventory/stock-errors";
import { findWarehouseInScope } from "../inventory/warehouse-service";
import { findPoInScope, branchWhere } from "./purchase-order-service";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const MAX_QTY = 1_000_000_000;
const hasAtMost4dp = (n: number) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6;

const qty = z
  .number()
  .finite()
  .nonnegative("Quantity can't be negative")
  .max(MAX_QTY)
  .refine(hasAtMost4dp, "Quantity supports at most 4 decimal places");

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Not a real date");

const lineSchema = z
  .object({
    poLineId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    receivedQty: qty,
    acceptedQty: qty,
    rejectedQty: qty,
    rejectReason: z.enum(REJECT_REASONS).optional(),
    supplierLotRef: z.string().trim().max(100).optional(),
    expiryDate: dateOnlySchema.optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((d, ctx) => {
    if (!D(d.acceptedQty).add(D(d.rejectedQty)).equals(D(d.receivedQty))) {
      ctx.addIssue({ code: "custom", message: "acceptedQty + rejectedQty must equal receivedQty", path: ["acceptedQty"] });
    }
    if (D(d.rejectedQty).greaterThan(0) && !d.rejectReason) {
      ctx.addIssue({ code: "custom", message: "rejectReason is required when rejectedQty > 0", path: ["rejectReason"] });
    }
    if (D(d.receivedQty).equals(0)) {
      ctx.addIssue({ code: "custom", message: "receivedQty must be greater than zero", path: ["receivedQty"] });
    }
  });

const receiveSchema = z.object({
  clientRequestId: z.string().uuid(),
  deliveryReference: z.string().trim().max(100).optional(),
  receivedAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, "receivedAt cannot be in the future")
    .optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(lineSchema).min(1, "Add at least one line").max(100),
});

// Receiving is only meaningful once the supplier commitment exists
// (confirmed) and while there is still something outstanding
// (partially_received). draft has nothing to receive against yet; closed /
// cancelled / received are terminal for receiving purposes.
const RECEIVABLE_PO_STATUSES = new Set(["confirmed", "partially_received"]);

type ReceiptRow = Prisma.GoodsReceiptGetPayload<{
  include: {
    lines: { include: { item: { select: { sku: true; name: true } }; lot: true } };
  };
}>;

const RECEIPT_INCLUDE = {
  lines: { orderBy: { id: "asc" as const }, include: { item: { select: { sku: true, name: true } }, lot: true } },
} as const;

function toReceiptView(r: ReceiptRow, canSeeCost: boolean) {
  return {
    id: r.id,
    poId: r.poId,
    branchId: r.branchId,
    deliveryReference: r.deliveryReference,
    receivedAt: r.receivedAt,
    notes: r.notes,
    createdAt: r.createdAt,
    lines: r.lines.map((l) => ({
      id: l.id,
      poLineId: l.poLineId,
      itemId: l.itemId,
      sku: l.item.sku,
      itemName: l.item.name,
      warehouseId: l.warehouseId,
      receivedQty: l.receivedQty.toString(),
      acceptedQty: l.acceptedQty.toString(),
      rejectedQty: l.rejectedQty.toString(),
      rejectReason: l.rejectReason,
      ...(canSeeCost ? { unitCost: l.unitCost.toString(), currency: l.currency.trim() } : {}),
      notes: l.notes,
      lot: l.lot
        ? {
            id: l.lot.id,
            lotNumber: l.lot.lotNumber,
            quantityReceived: l.lot.quantityReceived.toString(),
            status: l.lot.status,
            expiryDate: l.lot.expiryDate ? l.lot.expiryDate.toISOString().slice(0, 10) : null,
          }
        : null,
    })),
  };
}

async function findReceiptInScope(session: AuthenticatedSession, id: string): Promise<ReceiptRow | null> {
  return prisma.goodsReceipt.findFirst({ where: { orgId: session.orgId, id, ...branchWhere(session) }, include: RECEIPT_INCLUDE });
}

export async function getGoodsReceipt(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "goods_receipt:read");
  if (!z.string().uuid().safeParse(id).success) throw new NotFoundError("Goods receipt");
  const r = await findReceiptInScope(session, id);
  if (!r) throw new NotFoundError("Goods receipt");
  return toReceiptView(r, hasCapability(session.role, "cost:read"));
}

/** Receipts (with lines) for one purchase order -- used by the PO detail page. */
export async function listGoodsReceiptsForPo(session: AuthenticatedSession, poId: string) {
  assertCapability(session.role, "goods_receipt:read");
  const po = await findPoInScope(session, poId);
  if (!po) throw new NotFoundError("Purchase order");
  const rows = await prisma.goodsReceipt.findMany({
    where: { orgId: session.orgId, poId },
    include: RECEIPT_INCLUDE,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
  });
  const canSeeCost = hasCapability(session.role, "cost:read");
  return rows.map((r) => toReceiptView(r, canSeeCost));
}

/**
 * Records a goods receipt against a confirmed purchase order: one or more
 * lines, each inspected (accepted/rejected), the accepted quantity posted
 * to stock and traced into a MaterialLot, and the PO's status recomputed.
 * See the file header for the governing design decisions.
 */
export async function receiveGoodsForPurchaseOrder(session: AuthenticatedSession, poId: string, input: unknown) {
  assertCapability(session.role, "goods_receipt:create");
  if (!z.string().uuid().safeParse(poId).success) throw new NotFoundError("Purchase order");
  const parsed = receiveSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid goods receipt", parsed.error.issues);
  const d = parsed.data;

  // Header-level idempotency, checked before the transaction: a retried
  // "post this delivery" request must not re-run the per-line loop. Same
  // shape as receiveStock/adjustStock's own (per-movement) clientRequestId
  // check in stock-service.ts, just at the whole-submission level here.
  const existingReceipt = await prisma.goodsReceipt.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (existingReceipt) {
    if (existingReceipt.poId !== poId) throw new ConflictError("clientRequestId was already used for a different purchase order's receipt");
    return { replayed: true, receipt: await getGoodsReceipt(session, existingReceipt.id) };
  }

  const po = await findPoInScope(session, poId);
  if (!po) throw new NotFoundError("Purchase order");
  if (!RECEIVABLE_PO_STATUSES.has(po.status)) {
    throw new ConflictError(`A "${po.status.replace(/_/g, " ")}" purchase order cannot receive goods`);
  }

  // Pre-validate against the PO snapshot taken above. Safe to read
  // itemId/unitPrice/currency/uom from these lines rather than re-fetching
  // under lock below: PurchaseOrderLine rows are only ever replaced while
  // the PO is "draft" (updatePurchaseOrder enforces this), and receiving is
  // only reachable once the PO is "confirmed" or later -- by that point the
  // lines are immutable for the rest of the PO's life.
  const poLineById = new Map(po.lines.map((l) => [l.id, l]));
  const warehouseById = new Map<string, NonNullable<Awaited<ReturnType<typeof findWarehouseInScope>>>>();
  for (const line of d.lines) {
    const poLine = poLineById.get(line.poLineId);
    if (!poLine) throw new ValidationError(`poLineId ${line.poLineId} does not belong to this purchase order`);
    if (!warehouseById.has(line.warehouseId)) {
      const wh = await findWarehouseInScope(session, line.warehouseId);
      if (!wh) throw new ValidationError(`warehouseId ${line.warehouseId} does not exist or is not accessible`);
      if (!wh.isActive) throw new ValidationError(`Warehouse "${wh.name}" is inactive`);
      if (wh.branchId !== po.branchId) throw new ValidationError(`Warehouse "${wh.name}" is not in this purchase order's branch`);
      warehouseById.set(line.warehouseId, wh);
    }
  }

  // Merge duplicate poLineId submissions (a line split across two
  // warehouses in the same delivery) so the over-accept check below sees
  // the combined effect of this whole submission, not each row alone.
  const submittedAcceptedByLine = new Map<string, Prisma.Decimal>();
  for (const line of d.lines) {
    submittedAcceptedByLine.set(line.poLineId, (submittedAcceptedByLine.get(line.poLineId) ?? D(0)).add(D(line.acceptedQty)));
  }

  let receiptId: string;
  try {
    receiptId = await prisma.$transaction(async (tx) => {
      // Lock the PO row for the rest of this transaction: two concurrent
      // receipts against the same PO must serialise here, otherwise both
      // could read the same "already accepted" totals and together accept
      // more than was ordered. Same lock cancelPurchaseOrder takes, for the
      // same reason (see that function's comment).
      await tx.$queryRaw`SELECT id FROM purchase_order WHERE id = ${po.id}::uuid AND org_id = ${session.orgId}::uuid FOR UPDATE`;

      const freshLines = await tx.purchaseOrderLine.findMany({ where: { orgId: session.orgId, poId: po.id } });
      const alreadyAccepted = await tx.goodsReceiptLine.groupBy({
        by: ["poLineId"],
        where: { orgId: session.orgId, poLineId: { in: freshLines.map((l) => l.id) } },
        _sum: { acceptedQty: true },
      });
      const acceptedSoFar = new Map(alreadyAccepted.map((r) => [r.poLineId, r._sum.acceptedQty ?? D(0)]));
      for (const fl of freshLines) {
        const additional = submittedAcceptedByLine.get(fl.id);
        if (!additional || additional.equals(0)) continue;
        const already = acceptedSoFar.get(fl.id) ?? D(0);
        const ordered = D(fl.quantity);
        if (already.add(additional).greaterThan(ordered)) {
          const outstanding = ordered.sub(already);
          throw new ConflictError(
            `Accepting ${additional.toString()} more of this line would exceed the ordered quantity -- only ` +
              `${(outstanding.lessThan(0) ? D(0) : outstanding).toString()} remains outstanding`,
          );
        }
      }

      const receivedAtDefault = d.receivedAt ?? new Date();
      const receipt = await tx.goodsReceipt.create({
        data: {
          orgId: session.orgId,
          poId: po.id,
          branchId: po.branchId,
          deliveryReference: d.deliveryReference ?? null,
          receivedAt: receivedAtDefault,
          notes: d.notes ?? null,
          clientRequestId: d.clientRequestId,
          createdById: session.userId,
        },
      });

      // Lot numbering: same advisory-lock + MAX pattern purchase-order
      // numbering uses in purchase-order-service.ts, scoped to this org.
      // The lock is taken once and the running sequence is then kept in
      // memory for the rest of this transaction -- safe because the lock
      // is held until commit, so nothing else can insert a lot for this
      // org in between.
      let nextLotSeq: number | null = null;
      const nextLotNumber = async (): Promise<string> => {
        if (nextLotSeq === null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"material_lot_number:" + session.orgId}))`;
          const last = await tx.$queryRaw<{ n: number | null }[]>`
            SELECT MAX(substring(lot_number from '^LOT-([0-9]+)$')::int) AS n
              FROM material_lot WHERE org_id = ${session.orgId}::uuid`;
          nextLotSeq = (last[0]?.n ?? 0) + 1;
        } else {
          nextLotSeq += 1;
        }
        return `LOT-${String(nextLotSeq).padStart(6, "0")}`;
      };

      for (const line of d.lines) {
        const poLine = poLineById.get(line.poLineId)!;
        const wh = warehouseById.get(line.warehouseId)!;
        const receivedAtLine = receivedAtDefault;

        if (D(line.acceptedQty).greaterThan(0)) {
          // One stock movement per accepted line, through the single
          // canonical insert path (see stock-core.ts). The GoodsReceiptLine
          // and MaterialLot rows are created in afterInsert so they commit
          // or roll back atomically with the movement itself and with the
          // rest of this outer transaction.
          await postMovementInTransaction(tx, session, {
            warehouse: { id: wh.id, branchId: wh.branchId },
            itemId: poLine.itemId,
            movementType: "purchase_receipt",
            quantity: D(line.acceptedQty),
            unitCost: D(poLine.unitPrice),
            currency: poLine.currency,
            referenceType: "purchase_order",
            referenceId: po.id,
            reason: d.deliveryReference ?? null,
            // Fresh per-movement id: the header-level clientRequestId above
            // already guarantees this whole submission runs at most once.
            clientRequestId: randomUUID(),
            occurredAt: receivedAtLine,
            afterInsert: async (innerTx) => {
              const grLine = await innerTx.goodsReceiptLine.create({
                data: {
                  orgId: session.orgId,
                  receiptId: receipt.id,
                  poLineId: poLine.id,
                  itemId: poLine.itemId,
                  warehouseId: wh.id,
                  receivedQty: D(line.receivedQty),
                  acceptedQty: D(line.acceptedQty),
                  rejectedQty: D(line.rejectedQty),
                  rejectReason: line.rejectReason ?? null,
                  unitCost: D(poLine.unitPrice),
                  currency: poLine.currency,
                  notes: line.notes ?? null,
                },
              });
              const lotNumber = await nextLotNumber();
              await innerTx.materialLot.create({
                data: {
                  orgId: session.orgId,
                  lotNumber,
                  itemId: poLine.itemId,
                  supplierId: po.supplierId,
                  supplierLotRef: line.supplierLotRef ?? null,
                  receiptLineId: grLine.id,
                  warehouseId: wh.id,
                  quantityReceived: D(line.acceptedQty),
                  uom: poLine.uom,
                  expiryDate: line.expiryDate ? new Date(`${line.expiryDate}T00:00:00Z`) : null,
                  receivedAt: receivedAtLine,
                },
              });
            },
          });
        } else {
          // Fully rejected: no stock movement and therefore no lot, but
          // the inspection result itself is still recorded.
          await tx.goodsReceiptLine.create({
            data: {
              orgId: session.orgId,
              receiptId: receipt.id,
              poLineId: poLine.id,
              itemId: poLine.itemId,
              warehouseId: wh.id,
              receivedQty: D(line.receivedQty),
              acceptedQty: D(0),
              rejectedQty: D(line.rejectedQty),
              rejectReason: line.rejectReason ?? null,
              unitCost: D(poLine.unitPrice),
              currency: poLine.currency,
              notes: line.notes ?? null,
            },
          });
        }
      }

      // Recompute the PO's status from the now-complete picture (this
      // receipt's own lines included -- read-your-writes within this
      // transaction).
      const totals = await tx.goodsReceiptLine.groupBy({
        by: ["poLineId"],
        where: { orgId: session.orgId, poLineId: { in: freshLines.map((l) => l.id) } },
        _sum: { acceptedQty: true },
      });
      const acceptedTotal = new Map(totals.map((r) => [r.poLineId, r._sum.acceptedQty ?? D(0)]));
      let anyAccepted = false;
      let allComplete = true;
      for (const fl of freshLines) {
        const acc = acceptedTotal.get(fl.id) ?? D(0);
        if (acc.greaterThan(0)) anyAccepted = true;
        if (acc.lessThan(D(fl.quantity))) allComplete = false;
      }
      const newStatus = allComplete ? "received" : anyAccepted ? "partially_received" : po.status;
      if (newStatus !== po.status) {
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: newStatus } });
      }

      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: po.branchId,
        actorUserId: session.userId,
        entityType: "goods_receipt",
        entityId: receipt.id,
        action: "create",
        afterValue: { poId: po.id, lineCount: d.lines.length, deliveryReference: d.deliveryReference ?? null },
      });

      return receipt.id;
    });
  } catch (err) {
    if (isBalanceCreationRace(err)) {
      // Two first-ever movements for the same (item, warehouse) raced to
      // create the stock_balance row. Unlike postMovement's standalone
      // callers, a composite, multi-insert submission like this one can't
      // safely retry just the insert that lost -- the whole transaction
      // would need to restart. Surface it as a conflict so the client
      // retries the whole request.
      throw new ConflictError("A concurrent stock update collided with this receipt; please retry the request");
    }
    throw mapStockTriggerError(err);
  }

  return { replayed: false, receipt: await getGoodsReceipt(session, receiptId) };
}

// Internal helper re-exported for the frontend/API layer's receiving form,
// which needs to show each PO line's current outstanding quantity before
// the user fills in what actually arrived.
export { RECEIVABLE_PO_STATUSES };
