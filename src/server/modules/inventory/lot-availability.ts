// Shared lot-availability math used by material-issue-service.ts (consuming
// and returning against a lot) and lot-service.ts (browsing/searching lots
// and the traceability chain). One place for "what does this lot have left
// and can it be drawn from" so the two call sites can never drift.
//
// remaining is NEVER stored -- same "no duplicate source of truth"
// convention as StockBalance (trigger-derived) and PurchaseOrderLine's
// outstanding quantity (summed from GoodsReceiptLine). It is always
// quantityReceived - SUM(LotConsumption.quantity), computed here.
import { Prisma } from "../../../generated/prisma/client";

const D = (v: unknown) => new Prisma.Decimal(String(v));

type Db = Pick<Prisma.TransactionClient, "materialLot" | "lotConsumption" | "$executeRaw" | "$queryRaw">;

export interface LotRow {
  id: string;
  lotNumber: string;
  itemId: string;
  warehouseId: string;
  supplierId: string;
  uom: string;
  status: string;
  expiryDate: Date | null;
  receivedAt: Date;
  quantityReceived: Prisma.Decimal;
  remaining: Prisma.Decimal;
}

/**
 * Every lot this org has ever received/spawned for one item in one
 * warehouse, with `remaining` computed. Ordering is FEFO (earliest expiry
 * first, lots with no expiry last, then earliest received first) -- the
 * order auto-allocation consumes in, and a sensible default display order.
 * No advisory lock: safe for read-only display (the lot picker, the lot
 * detail page). Callers that are about to WRITE a LotConsumption row must
 * use lockAndGetRemaining below instead, inside their own transaction.
 */
export async function listLotsWithRemaining(db: Db, orgId: string, itemId: string, warehouseId: string): Promise<LotRow[]> {
  const lots = await db.materialLot.findMany({
    where: { orgId, itemId, warehouseId },
    orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }],
  });
  if (lots.length === 0) return [];
  const consumed = await db.lotConsumption.groupBy({
    by: ["lotId"],
    where: { orgId, lotId: { in: lots.map((l) => l.id) } },
    _sum: { quantity: true },
  });
  const consumedByLot = new Map(consumed.map((c) => [c.lotId, D(c._sum.quantity ?? 0)]));
  const rows = lots.map((l) => ({
    id: l.id,
    lotNumber: l.lotNumber,
    itemId: l.itemId,
    warehouseId: l.warehouseId,
    supplierId: l.supplierId,
    uom: l.uom,
    status: l.status,
    expiryDate: l.expiryDate,
    receivedAt: l.receivedAt,
    quantityReceived: D(l.quantityReceived),
    remaining: D(l.quantityReceived).sub(consumedByLot.get(l.id) ?? D(0)),
  }));
  // Postgres NULLS are already sorted last by the `asc` ordering above for a
  // nullable column, which is exactly FEFO's "no expiry sorts after any
  // expiry" rule -- no re-sort needed.
  return rows;
}

/** status=active, not expired (as of `asOf`), and something left to draw. */
export function isAvailable(lot: Pick<LotRow, "status" | "expiryDate" | "remaining">, asOf: Date = new Date()): boolean {
  if (lot.status !== "active") return false;
  if (lot.expiryDate && lot.expiryDate.getTime() < startOfDay(asOf).getTime()) return false;
  return lot.remaining.greaterThan(0);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Serializes concurrent writers against the SAME set of lots so two
 * in-flight issues/returns can never both read "remaining" before either
 * commits and jointly overdraw a lot -- the same pg_advisory_xact_lock
 * pattern purchase-order-service.ts / goods-receipt-service.ts already use
 * for gap-free numbering, applied here per-lot instead of per-org. Locks are
 * acquired in a fixed (sorted) order across all lots involved so two
 * transactions that both touch lots A and B can never deadlock by locking
 * them in opposite order.
 */
export async function lockLots(tx: Db, lotIds: string[]): Promise<void> {
  const sorted = [...new Set(lotIds)].sort();
  for (const id of sorted) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"lot_consumption:" + id}))`;
  }
}

/** Remaining for a specific set of lots, re-read AFTER lockLots so the figures are authoritative for this transaction. */
export async function getRemainingForLots(tx: Db, orgId: string, lotIds: string[]): Promise<Map<string, Prisma.Decimal>> {
  if (lotIds.length === 0) return new Map();
  const lots = await tx.materialLot.findMany({ where: { orgId, id: { in: lotIds } } });
  const consumed = await tx.lotConsumption.groupBy({ by: ["lotId"], where: { orgId, lotId: { in: lotIds } }, _sum: { quantity: true } });
  const consumedByLot = new Map(consumed.map((c) => [c.lotId, D(c._sum.quantity ?? 0)]));
  return new Map(lots.map((l) => [l.id, D(l.quantityReceived).sub(consumedByLot.get(l.id) ?? D(0))]));
}
