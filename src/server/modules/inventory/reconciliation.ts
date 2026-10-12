// Proves the ledger invariant: for every (item, warehouse),
//   stock_balance.quantity == SUM(stock_movement.quantity)
// The balance is a trigger-maintained cache over the immutable ledger, never a
// second source of truth. This is the standing check from ARCHITECTURE.md §7;
// it is used by the test suite and can be wired to a scheduled job later.
// Internal (no session): callers decide who may trigger it.
import { prisma } from "../../shared/db";
import { Prisma } from "../../../generated/prisma/client";

export interface BalanceMismatch {
  itemId: string;
  warehouseId: string;
  balance: string;
  ledgerSum: string;
}

export async function findBalanceMismatches(orgId: string): Promise<BalanceMismatch[]> {
  const [balances, sums] = await Promise.all([
    prisma.stockBalance.findMany({ where: { orgId } }),
    prisma.stockMovement.groupBy({ by: ["itemId", "warehouseId"], where: { orgId }, _sum: { quantity: true } }),
  ]);
  const key = (i: string, w: string) => `${i}|${w}`;
  const sumByKey = new Map(sums.map((s) => [key(s.itemId, s.warehouseId), new Prisma.Decimal(s._sum.quantity ?? 0)]));
  const out: BalanceMismatch[] = [];

  for (const b of balances) {
    const ledger = sumByKey.get(key(b.itemId, b.warehouseId)) ?? new Prisma.Decimal(0);
    if (!new Prisma.Decimal(b.quantity).equals(ledger)) {
      out.push({ itemId: b.itemId, warehouseId: b.warehouseId, balance: b.quantity.toString(), ledgerSum: ledger.toString() });
    }
    sumByKey.delete(key(b.itemId, b.warehouseId));
  }
  // Ledger rows with no balance row at all would also be a violation.
  for (const [k, v] of sumByKey) {
    if (!v.isZero()) {
      const [itemId, warehouseId] = k.split("|");
      out.push({ itemId, warehouseId, balance: "(no balance row)", ledgerSum: v.toString() });
    }
  }
  return out;
}
