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

export type PostableMovementType = "purchase_receipt" | "adjustment" | "production_consumption";

export interface PostMovementArgs {
  warehouse: { id: string; branchId: string };
  itemId: string;
  movementType: PostableMovementType;
  /** Signed. Receipts positive, consumption negative. */
  quantity: Prisma.Decimal;
  /** Required for positive movements. Must be null for negative ones (the trigger stamps the average cost). */
  unitCost: Prisma.Decimal | null;
  currency: string | null;
  referenceType: "manual" | "production_job";
  referenceId: string | null;
  reason: string | null;
  clientRequestId: string;
  occurredAt?: Date;
  /** Runs inside the same transaction, after the movement is written (e.g. job released -> in_progress). */
  afterInsert?: (tx: Prisma.TransactionClient) => Promise<void>;
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

export async function postMovement(session: AuthenticatedSession, a: PostMovementArgs): Promise<PostResult> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const movement = await prisma.$transaction(async (tx) => {
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
        if (a.afterInsert) await a.afterInsert(tx);
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
        return created;
      });
      return { replayed: false, movement: movement as unknown as MovementRow };
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
