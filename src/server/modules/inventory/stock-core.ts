// The ONE place a stock movement is written. Receipts, adjustments and
// issues to jobs all go through postMovement so idempotency, branch
// consistency, error mapping and auditing cannot drift between them.
//
// What this file does NOT do, on purpose: it never touches stock_balance and
// never computes a balance or average cost. The DB trigger does that
// atomically in the same statement; the runtime role only has SELECT on
// stock_balance. The service layer cannot get it wrong because it cannot
// write it.
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { hasCapability, type Role } from "../../shared/authz";
import { ConflictError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { isBalanceCreationRace, mapStockTriggerError } from "./stock-errors";

// "material_return" added for Phase One of the next mandate round
// (migration 20261105120000_lot_consumption_and_traceability):
// material-issue-service.ts's returnMaterialFromJob posts unused/returned
// material back into a warehouse as a POSITIVE movement, same sign
// convention as purchase_receipt -- see that file's header comment for why
// its unit_cost must be the cost basis of what is being reversed, not an
// arbitrary caller-supplied figure.
export type PostableMovementType = "purchase_receipt" | "adjustment" | "production_consumption" | "material_return";

export interface PostMovementArgs {
  warehouse: { id: string; branchId: string };
  itemId: string;
  movementType: PostableMovementType;
  /** Signed. Receipts positive, consumption negative. */
  quantity: Prisma.Decimal;
  /** Required for positive movements. Must be null for negative ones (the trigger stamps the average cost). */
  unitCost: Prisma.Decimal | null;
  currency: string | null;
  // "purchase_order" added for goods-receiving (goods-receipt-service.ts):
  // a receipt's accepted quantity is posted with referenceId = the PO's id,
  // matching the ReferenceType enum's existing "purchase_order" value in
  // schema.prisma (anticipated there since the init migration, never used
  // until now). The ledger's reference granularity stays at the business-
  // document level, same as "production_job" -- not per-receipt; the
  // specific receipt/lot detail lives in GoodsReceiptLine/MaterialLot,
  // joinable from there, same division of responsibility as every other
  // reference type here.
  referenceType: "manual" | "production_job" | "purchase_order";
  referenceId: string | null;
  reason: string | null;
  clientRequestId: string;
  occurredAt?: Date;
  /**
   * Runs inside the same transaction, after the movement is written (e.g.
   * job released -> in_progress; or, as of this milestone, writing the
   * LotConsumption rows / quarantine MaterialLot a lot-tracked issue or
   * return needs — see material-issue-service.ts). The created movement row
   * is passed as the second argument so callers that need its id (to link a
   * child row back to it) don't have to re-query for it; existing callers
   * that only take `tx` remain valid (TypeScript allows assigning a
   * shorter-parameter-list function where more parameters are accepted).
   */
  afterInsert?: (tx: Prisma.TransactionClient, movement: MovementRow) => Promise<void>;
}

interface MovementRow {
  id: string;
  orgId: string;
  branchId: string;
  itemId: string;
  warehouseId: string;
  movementType: string;
  quantity: unknown;
  unitCost: unknown;
  currency: string | null;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  createdById: string | null;
  occurredAt: Date;
  syncedAt: Date;
}

export interface PostResult {
  replayed: boolean;
  movement: MovementRow;
}

function sameRequest(existing: MovementRow, a: PostMovementArgs): boolean {
  return (
    existing.itemId === a.itemId &&
    existing.warehouseId === a.warehouse.id &&
    existing.movementType === a.movementType &&
    new Prisma.Decimal(String(existing.quantity)).equals(a.quantity) &&
    (existing.referenceId ?? null) === (a.referenceId ?? null)
  );
}

export async function findByClientRequestId(orgId: string, clientRequestId: string): Promise<MovementRow | null> {
  return prisma.stockMovement.findFirst({ where: { orgId, clientRequestId } }) as Promise<MovementRow | null>;
}

export function checkReplay(existing: MovementRow, a: PostMovementArgs): PostResult {
  if (!sameRequest(existing, a)) {
    throw new ConflictError("clientRequestId was already used for a different stock movement");
  }
  return { replayed: true, movement: existing };
}

// Core insert, factored out so composite, multi-table operations that need
// the stock-movement write inside their OWN already-open transaction (for
// atomicity across several inserts that must all succeed or all fail
// together -- e.g. goods-receipt-service.ts, which also writes a
// GoodsReceipt header, GoodsReceiptLine rows and MaterialLot rows in the
// same transaction) can reuse the exact same insert this file's header
// comment promises is the ONE place a stock movement is written, instead of
// a second, divergence-prone copy of it. postMovement below is now a thin
// wrapper: open a transaction, call this, handle the replay/retry cases
// that only make sense for a single standalone movement.
async function insertMovementTx(tx: Prisma.TransactionClient, session: AuthenticatedSession, a: PostMovementArgs): Promise<MovementRow> {
  const created = await tx.stockMovement.create({
    data: {
      orgId: session.orgId,
      branchId: a.warehouse.branchId,
      itemId: a.itemId,
      warehouseId: a.warehouse.id,
      movementType: a.movementType,
      quantity: a.quantity,
      unitCost: a.unitCost,
      currency: a.currency,
      referenceType: a.referenceType,
      referenceId: a.referenceId,
      reason: a.reason,
      clientRequestId: a.clientRequestId,
      createdById: session.userId,
      ...(a.occurredAt ? { occurredAt: a.occurredAt } : {}),
    },
  });
  if (a.afterInsert) await a.afterInsert(tx, created as unknown as MovementRow);
  await recordAudit(tx, {
    orgId: session.orgId,
    branchId: a.warehouse.branchId,
    actorUserId: session.userId,
    entityType: "stock_movement",
    entityId: created.id,
    action: "create",
    afterValue: {
      movementType: a.movementType,
      itemId: a.itemId,
      warehouseId: a.warehouse.id,
      quantity: a.quantity.toString(),
      referenceType: a.referenceType,
      referenceId: a.referenceId,
    },
    reason: a.reason,
  });
  return created as unknown as MovementRow;
}

export async function postMovement(session: AuthenticatedSession, a: PostMovementArgs): Promise<PostResult> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const movement = await prisma.$transaction((tx) => insertMovementTx(tx, session, a));
      return { replayed: false, movement };
    } catch (err) {
      // Same clientRequestId racing itself: hand back the winner's row.
      const winner = await findByClientRequestId(session.orgId, a.clientRequestId);
      if (winner) return checkReplay(winner, a);
      // Two first-ever movements for one (item, warehouse) raced to create
      // the balance row inside the trigger. Nothing was committed; retry.
      if (isBalanceCreationRace(err) && attempt < MAX_ATTEMPTS) continue;
      throw mapStockTriggerError(err);
    }
  }
}

/**
 * For composite operations that need the stock-movement write inside their
 * OWN already-open transaction (see insertMovementTx's comment above for
 * why this exists rather than nesting postMovement itself, which always
 * opens its own transaction against the pooled `prisma` client -- doing
 * that from inside another transaction would use a second connection and
 * would NOT roll back together with the caller's transaction on failure,
 * silently breaking atomicity).
 *
 * Callers are responsible for their own idempotency at the composite-
 * operation level (see goods-receipt-service.ts's header-level
 * clientRequestId check) and for serialising the specific race they care
 * about (e.g. an advisory lock or a `SELECT ... FOR UPDATE` on the parent
 * row) -- this function does not retry on the balance-creation race the way
 * postMovement does, because retrying would mean restarting the caller's
 * entire outer transaction, not just this one insert. A race here simply
 * fails the whole submission (409/500), same as any other conflict the
 * caller's transaction can raise; the client retries the whole request.
 */
export async function postMovementInTransaction(tx: Prisma.TransactionClient, session: AuthenticatedSession, a: PostMovementArgs): Promise<MovementRow> {
  return insertMovementTx(tx, session, a);
}

export function toMovementView(role: Role, m: MovementRow) {
  const view: Record<string, unknown> = {
    id: m.id,
    branchId: m.branchId,
    itemId: m.itemId,
    warehouseId: m.warehouseId,
    movementType: m.movementType,
    quantity: m.quantity,
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    reason: m.reason,
    createdById: m.createdById,
    occurredAt: m.occurredAt,
    syncedAt: m.syncedAt,
  };
  // Unit costs are valuation data: only callers who may see cost get them.
  if (hasCapability(role, "cost:read")) {
    view.unitCost = m.unitCost;
    view.currency = m.currency;
  }
  return view;
}

export async function readBalance(session: AuthenticatedSession, itemId: string, warehouseId: string) {
  if (!hasCapability(session.role, "stock:read")) return undefined;
  const b = await prisma.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } });
  if (!b) return null;
  const view: Record<string, unknown> = { itemId, warehouseId, quantity: b.quantity, updatedAt: b.updatedAt };
  if (hasCapability(session.role, "cost:read")) {
    view.averageUnitCost = b.averageUnitCost;
    view.averageUnitCostCurrency = b.averageUnitCostCurrency;
  }
  return view;
}
