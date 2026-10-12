/* eslint-disable @typescript-eslint/no-explicit-any -- movement/balance views are intentionally loose Record<string, unknown> projections */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { listAuditLog } from "../../iam/audit-service";
import { createItem, updateItem } from "../../catalog/item-service";
import { prisma } from "../../../shared/db";
import { createWarehouse, listWarehouses } from "../warehouse-service";
import { receiveStock, adjustStock, listStockBalances, listStockMovements } from "../stock-service";
import { findBalanceMismatches } from "../reconciliation";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { sessionWithRole } from "../../production/__tests__/production-helpers";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let inv: AuthenticatedSession; // INVENTORY_MANAGER, main branch
let inv2: AuthenticatedSession; // INVENTORY_MANAGER, branch 2 only
let prodMgr: AuthenticatedSession;
let operator: AuthenticatedSession;
let viewer: AuthenticatedSession;
let finance: AuthenticatedSession;
let wh1: string; // main branch
let wh2: string; // branch 2

let n = 0;
async function material(session = ownerA, extra: Record<string, unknown> = {}) {
  n += 1;
  return createItem(session, { sku: `STK-${Date.now().toString(36)}-${n}`, itemType: "raw_material", name: "Stock test material", uom: "kg", ...extra });
}
const receipt = (over: Record<string, unknown>) => ({
  clientRequestId: randomUUID(),
  warehouseId: wh1,
  quantity: 10,
  unitCost: 2,
  currency: "USD",
  ...over,
});
const bal = async (itemId: string, warehouseId = wh1) => {
  const rows = (await listStockBalances(ownerA, { itemId, warehouseId })) as any[];
  return rows[0];
};

beforeAll(async () => {
  orgA = await createTestOrg("stkA");
  orgB = await createTestOrg("stkB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  wh1 = (await createWarehouse(ownerA, { branchId: orgA.branchId, name: "Main store" })).id;
  wh2 = (await createWarehouse(ownerA, { branchId: branch2, name: "Second store" })).id;
  inv = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "inv", [orgA.branchId]);
  inv2 = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "inv2", [branch2]);
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "vw", [orgA.branchId]);
  finance = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fm", [orgA.branchId]);
}, 240_000);

describe("warehouses", () => {
  it("creates a warehouse, audits it, and rejects a duplicate name within the branch", async () => {
    const w = await createWarehouse(ownerA, { branchId: orgA.branchId, name: `Yard ${randomUUID().slice(0, 6)}` });
    const entries = (await listAuditLog(ownerA, { entityType: "warehouse", entityId: w.id })) as any[];
    expect(entries.some((e) => e.action === "create")).toBe(true);
    await expect(createWarehouse(ownerA, { branchId: orgA.branchId, name: w.name })).rejects.toBeInstanceOf(ConflictError);
  });

  it("capability and branch scope: inventory manager yes, production manager no, other-branch manager no", async () => {
    await expect(createWarehouse(inv, { branchId: orgA.branchId, name: `Inv ${randomUUID().slice(0, 6)}` })).resolves.toBeTruthy();
    await expect(createWarehouse(prodMgr, { branchId: orgA.branchId, name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createWarehouse(inv2, { branchId: orgA.branchId, name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lists only warehouses in granted branches", async () => {
    const seen = (await listWarehouses(inv2)).map((w) => w.id);
    expect(seen).toContain(wh2);
    expect(seen).not.toContain(wh1);
    expect((await listWarehouses(ownerB)).some((w) => w.id === wh1)).toBe(false);
  });
});

describe("receiveStock", () => {
  it("writes an immutable ledger row and the balance follows from it", async () => {
    const m = await material();
    const res = await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 25 }));
    expect(res.replayed).toBe(false);
    expect(String(res.movement.quantity)).toBe("25");
    expect(res.movement.movementType).toBe("purchase_receipt");
    expect(String((res.balance as any).quantity)).toBe("25");
    const entries = (await listAuditLog(ownerA, { entityType: "stock_movement", entityId: res.movement.id as string })) as any[];
    expect(entries.some((e) => e.action === "create")).toBe(true);
  });

  it("values stock at weighted-average cost", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 10, unitCost: 2 }));
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 10, unitCost: 4 }));
    const b = await bal(m.id);
    expect(String(b.quantity)).toBe("20");
    expect(String(b.averageUnitCost)).toBe("3");
    expect(b.averageUnitCostCurrency).toBe("USD");
  });

  it("validates quantity, cost, currency, item type and inactive items", async () => {
    const m = await material();
    for (const bad of [
      receipt({ itemId: m.id, quantity: 0 }),
      receipt({ itemId: m.id, quantity: -5 }),
      receipt({ itemId: m.id, quantity: 1.00001 }),
      receipt({ itemId: m.id, unitCost: -1 }),
      receipt({ itemId: m.id, currency: "XXX" }),
      receipt({ itemId: "not-a-uuid" }),
      { warehouseId: wh1, itemId: m.id, quantity: 1, unitCost: 1, currency: "USD" }, // no clientRequestId
    ]) {
      await expect(receiveStock(ownerA, bad)).rejects.toBeInstanceOf(ValidationError);
    }
    const fg = await createItem(ownerA, { sku: `FG-${randomUUID().slice(0, 8)}`, itemType: "finished_good", name: "FG", uom: "ea" });
    await expect(receiveStock(ownerA, receipt({ itemId: fg.id }))).rejects.toBeInstanceOf(ValidationError);
    const inactive = await material();
    await updateItem(ownerA, inactive.id, { isActive: false });
    await expect(receiveStock(ownerA, receipt({ itemId: inactive.id }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("is idempotent: a replay returns the original and posts nothing new", async () => {
    const m = await material();
    const p = receipt({ itemId: m.id, quantity: 7 });
    const first = await receiveStock(ownerA, p);
    const second = await receiveStock(ownerA, p);
    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    expect(String((await bal(m.id)).quantity)).toBe("7");
    await expect(receiveStock(ownerA, { ...p, quantity: 8 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("concurrent FIRST receipts for one item all succeed and the balance is their sum", async () => {
    const m = await material();
    const results = await Promise.all(
      [1, 2, 3, 4].map((q) => receiveStock(ownerA, receipt({ itemId: m.id, quantity: q }))),
    );
    expect(results.every((r) => !r.replayed)).toBe(true);
    expect(String((await bal(m.id)).quantity)).toBe("10");
  });

  it("concurrent identical submissions create exactly one movement", async () => {
    const m = await material();
    const p = receipt({ itemId: m.id, quantity: 5 });
    const results = await Promise.all([receiveStock(ownerA, p), receiveStock(ownerA, p), receiveStock(ownerA, p)]);
    expect(new Set(results.map((r) => r.movement.id)).size).toBe(1);
    expect(String((await bal(m.id)).quantity)).toBe("5");
  });

  it("refuses to average a different currency into existing stock, but allows it once stock is used up", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 10, unitCost: 2, currency: "USD" }));
    await expect(receiveStock(ownerA, receipt({ itemId: m.id, quantity: 5, unitCost: 300, currency: "ZIG" }))).rejects.toBeInstanceOf(ConflictError);
    expect(String((await bal(m.id)).quantity)).toBe("10"); // nothing partially applied

    await adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: m.id, quantity: -10, reason: "write-off for currency switch" });
    await expect(receiveStock(ownerA, receipt({ itemId: m.id, quantity: 5, unitCost: 300, currency: "ZIG" }))).resolves.toBeTruthy();
    expect((await bal(m.id)).averageUnitCostCurrency).toBe("ZIG");
  });

  it("capabilities: owner and inventory manager may receive; production, operator, viewer, finance may not", async () => {
    const m = await material();
    await expect(receiveStock(inv, receipt({ itemId: m.id }))).resolves.toBeTruthy();
    for (const s of [prodMgr, operator, viewer, finance]) {
      await expect(receiveStock(s, receipt({ itemId: m.id }))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("tenant and branch isolation: other org / other branch see 'not found'", async () => {
    const m = await material();
    await expect(receiveStock(ownerB, receipt({ itemId: m.id }))).rejects.toBeInstanceOf(NotFoundError); // org A's warehouse
    await expect(receiveStock(inv2, receipt({ itemId: m.id }))).rejects.toBeInstanceOf(NotFoundError); // other branch
    const bItem = await material(ownerB);
    await expect(receiveStock(ownerA, receipt({ itemId: bItem.id }))).rejects.toBeInstanceOf(ValidationError); // org B's item
  });
});

describe("adjustStock", () => {
  it("negative adjustments are valued at the current average cost and need a reason", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 10, unitCost: 5 }));
    const res = await adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: m.id, quantity: -3, reason: "damaged in storage" });
    expect(String(res.movement.quantity)).toBe("-3");
    expect(String((res.balance as any).quantity)).toBe("7");
    await expect(adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: m.id, quantity: -1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("positive adjustments need a cost; negative ones must not supply one", async () => {
    const m = await material();
    const base = { warehouseId: wh1, itemId: m.id, reason: "stock take correction" };
    await expect(adjustStock(ownerA, { ...base, clientRequestId: randomUUID(), quantity: 5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(adjustStock(ownerA, { ...base, clientRequestId: randomUUID(), quantity: -5, unitCost: 1, currency: "USD" })).rejects.toBeInstanceOf(ValidationError);
    await expect(adjustStock(ownerA, { ...base, clientRequestId: randomUUID(), quantity: 5, unitCost: 1, currency: "USD" })).resolves.toBeTruthy();
  });

  it("cannot take stock below zero, and nothing is written when refused", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 4 }));
    await expect(
      adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: m.id, quantity: -5, reason: "too much" }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(String((await bal(m.id)).quantity)).toBe("4");
    const moves = (await listStockMovements(ownerA, { itemId: m.id })) as any[];
    expect(moves).toHaveLength(1);
  });

  it("an item that was never received cannot be adjusted down", async () => {
    const m = await material();
    await expect(
      adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: m.id, quantity: -1, reason: "nothing there" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("capabilities: owner and inventory manager only", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 10 }));
    const p = () => ({ clientRequestId: randomUUID(), warehouseId: wh1, itemId: m.id, quantity: -1, reason: "count variance" });
    await expect(adjustStock(inv, p())).resolves.toBeTruthy();
    for (const s of [prodMgr, operator, viewer, finance]) {
      await expect(adjustStock(s, p())).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("reading stock", () => {
  it("answers 'why is stock N?' with the actual ledger rows, newest first", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 10 }));
    await adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: m.id, quantity: -2, reason: "spillage" });
    const moves = (await listStockMovements(ownerA, { itemId: m.id })) as any[];
    expect(moves.map((x) => x.movementType).sort()).toEqual(["adjustment", "purchase_receipt"]);
    const sum = moves.reduce((acc, x) => acc + Number(x.quantity), 0);
    expect(sum).toBe(Number((await bal(m.id)).quantity));
  });

  it("hides unit costs from callers without cost:read", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id, quantity: 10, unitCost: 6 }));
    const asInv = ((await listStockBalances(inv, { itemId: m.id })) as any[])[0];
    expect("averageUnitCost" in asInv).toBe(false);
    const asFin = ((await listStockBalances(finance, { itemId: m.id })) as any[])[0];
    expect(String(asFin.averageUnitCost)).toBe("6");
    const mv = ((await listStockMovements(inv, { itemId: m.id })) as any[])[0];
    expect("unitCost" in mv).toBe(false);
  });

  it("branch and tenant isolation on reads; operators have no stock access", async () => {
    const m = await material();
    await receiveStock(ownerA, receipt({ itemId: m.id }));
    expect(((await listStockBalances(inv2, { itemId: m.id })) as any[])).toHaveLength(0);
    expect(((await listStockBalances(ownerB, { itemId: m.id })) as any[])).toHaveLength(0);
    expect(((await listStockMovements(ownerB, { itemId: m.id })) as any[])).toHaveLength(0);
    await expect(listStockMovements(inv2, { warehouseId: wh1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listStockBalances(operator)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("ledger integrity", () => {
  it("the application database role cannot update or delete ledger rows", async () => {
    const m = await material();
    const res = await receiveStock(ownerA, receipt({ itemId: m.id }));
    await expect(prisma.stockMovement.update({ where: { id: res.movement.id as string }, data: { quantity: 999 } })).rejects.toBeTruthy();
    await expect(prisma.stockMovement.delete({ where: { id: res.movement.id as string } })).rejects.toBeTruthy();
    await expect(prisma.stockBalance.update({ where: { itemId_warehouseId: { itemId: m.id, warehouseId: wh1 } }, data: { quantity: 999 } })).rejects.toBeTruthy();
    expect(String((await bal(m.id)).quantity)).toBe("10");
  });

  it("INVARIANT: every balance equals the sum of its ledger rows, after a mixed workload", async () => {
    const a = await material();
    const b = await material();
    await Promise.all([
      receiveStock(ownerA, receipt({ itemId: a.id, quantity: 100, unitCost: 2 })),
      receiveStock(ownerA, receipt({ itemId: b.id, quantity: 50, unitCost: 8 })),
      receiveStock(ownerA, receipt({ itemId: b.id, quantity: 5, unitCost: 8, warehouseId: wh2 })),
    ]);
    await receiveStock(ownerA, receipt({ itemId: a.id, quantity: 40, unitCost: 3 }));
    await adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: a.id, quantity: -25.5, reason: "count" });
    await adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: b.id, quantity: 12.25, unitCost: 9, currency: "USD", reason: "found stock" });
    await expect(adjustStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: b.id, quantity: -9999, reason: "refused" })).rejects.toBeInstanceOf(ConflictError);
    const dup = receipt({ itemId: a.id, quantity: 1 });
    await receiveStock(ownerA, dup);
    await receiveStock(ownerA, dup); // replay

    expect(await findBalanceMismatches(orgA.organizationId)).toEqual([]);
    expect(await findBalanceMismatches(orgB.organizationId)).toEqual([]);
  });
});
