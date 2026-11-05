/* eslint-disable @typescript-eslint/no-explicit-any -- toReceiptView's unitCost/currency are conditionally
   spread on a runtime `canSeeCost: boolean` (same shape as toView in purchase-order-service.ts), so TS
   infers a union of the two line shapes and can't statically narrow which branch a given role gets; same
   convention stock-service.test.ts and purchase-order-service.test.ts use for their own capability-gated
   view fields. */
// Real-database tests (same approach as every other module suite -- see
// e.g. purchase-order-service.test.ts's header comment). Fresh random org
// per test. NOT executed in this environment: see IMPLEMENTATION_MANIFEST.md
// -- writing and statically checking tests is within this environment's
// restrictions, connecting to a database is not. Run with
// `npm test -- goods-receipt-service` against your local test database.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { sessionWithRole } from "../../production/__tests__/production-helpers";
import { createItem } from "../../catalog/item-service";
import { createSupplier } from "../../suppliers/supplier-service";
import { createWarehouse } from "../../inventory/warehouse-service";
import { listStockBalances } from "../../inventory/stock-service";
import { prisma } from "../../../shared/db";
import { cancelPurchaseOrder, closePurchaseOrder, confirmPurchaseOrder, createPurchaseOrder, getPurchaseOrder } from "../purchase-order-service";
import { getGoodsReceipt, listGoodsReceiptsForPo, receiveGoodsForPurchaseOrder } from "../goods-receipt-service";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

async function setup(label: string) {
  const org: TestOrg = await createTestOrg(label);
  const owner = await ownerSession(org);
  const supplier = await createSupplier(owner, { name: `Supplier ${label}` });
  const material = await createItem(owner, { sku: `GR-MAT-${label}-${Date.now()}`, itemType: "raw_material", name: "Test material", uom: "kg" });
  const warehouse = await createWarehouse(owner, { branchId: org.branchId, name: `WH ${label}` });
  return { org, owner, supplier, material, warehouse };
}

const line = (itemId: string, quantity = 10, unitPrice = 5, uom = "kg") => ({ itemId, quantity, uom, unitPrice });

/** A confirmed, single-line PO ready to receive against. */
async function confirmedPo(label: string, quantity = 10, unitPrice = 5) {
  const ctx = await setup(label);
  const draft = await createPurchaseOrder(ctx.owner, { branchId: ctx.org.branchId, supplierId: ctx.supplier.id, currency: "USD", lines: [line(ctx.material.id, quantity, unitPrice)] });
  const po: any = await confirmPurchaseOrder(ctx.owner, draft.id);
  return { ...ctx, po };
}

function grLine(poLineId: string, warehouseId: string, receivedQty: number, rejectedQty = 0, extra: Record<string, unknown> = {}) {
  return {
    poLineId,
    warehouseId,
    receivedQty,
    acceptedQty: receivedQty - rejectedQty,
    rejectedQty,
    ...(rejectedQty > 0 ? { rejectReason: "damaged" } : {}),
    ...extra,
  };
}

const bal = async (session: AuthenticatedSession, itemId: string, warehouseId: string) => {
  const rows = (await listStockBalances(session, { itemId, warehouseId })) as any[];
  return rows[0];
};

describe("goods receipts: posting, lots and PO status", () => {
  it("a fully-accepted receipt posts one stock movement, creates a lot, and marks the PO received", async () => {
    const { owner, po, warehouse, material } = await confirmedPo("grfull", 10, 5);
    const poLine = po.lines[0];

    const result = await receiveGoodsForPurchaseOrder(owner, po.id, {
      clientRequestId: randomUUID(),
      deliveryReference: "DN-001",
      lines: [grLine(poLine.id, warehouse.id, 10)],
    });

    expect(result.replayed).toBe(false);
    const rl: any = result.receipt.lines[0];
    expect(rl.receivedQty).toBe("10");
    expect(rl.acceptedQty).toBe("10");
    expect(rl.rejectedQty).toBe("0");
    expect(rl.lot).toBeTruthy();
    expect(rl.lot.lotNumber).toBe("LOT-000001");
    expect(rl.lot.quantityReceived).toBe("10");
    expect(rl.lot.status).toBeTruthy();

    const updated: any = await getPurchaseOrder(owner, po.id);
    expect(updated.status).toBe("received");
    expect(updated.lines[0].receivedQty).toBe("10");
    expect(updated.lines[0].outstandingQty).toBe("0");

    const b = await bal(owner, material.id, warehouse.id);
    expect(String(b.quantity)).toBe("10");
  });

  it("partial acceptance sets partially_received; a second receipt completes it (accumulates correctly)", async () => {
    const { owner, po, warehouse, material } = await confirmedPo("grpartial", 10, 5);
    const poLine = po.lines[0];

    await receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, warehouse.id, 4)] });
    let updated: any = await getPurchaseOrder(owner, po.id);
    expect(updated.status).toBe("partially_received");
    expect(updated.lines[0].receivedQty).toBe("4");
    expect(updated.lines[0].outstandingQty).toBe("6");

    await receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, warehouse.id, 6)] });
    updated = await getPurchaseOrder(owner, po.id);
    expect(updated.status).toBe("received");
    expect(updated.lines[0].receivedQty).toBe("10");
    expect(updated.lines[0].outstandingQty).toBe("0");

    const b = await bal(owner, material.id, warehouse.id);
    expect(String(b.quantity)).toBe("10");

    const receipts = await listGoodsReceiptsForPo(owner, po.id);
    expect(receipts).toHaveLength(2);
  });

  it("a fully-rejected line posts no stock movement and creates no lot; the PO status is unaffected", async () => {
    const { owner, po, warehouse, material } = await confirmedPo("grreject", 10, 5);
    const poLine = po.lines[0];

    const result = await receiveGoodsForPurchaseOrder(owner, po.id, {
      clientRequestId: randomUUID(),
      lines: [grLine(poLine.id, warehouse.id, 5, 5)], // all 5 received, all 5 rejected, 0 accepted
    });
    const rl: any = result.receipt.lines[0];
    expect(rl.acceptedQty).toBe("0");
    expect(rl.rejectedQty).toBe("5");
    expect(rl.rejectReason).toBe("damaged");
    expect(rl.lot).toBeNull();

    const updated: any = await getPurchaseOrder(owner, po.id);
    expect(updated.status).toBe("confirmed"); // nothing accepted yet -- status does not advance
    expect(updated.lines[0].receivedQty).toBe("0"); // outstanding is driven by ACCEPTED qty, not received

    const rows = (await listStockBalances(owner, { itemId: material.id, warehouseId: warehouse.id })) as any[];
    expect(rows).toHaveLength(0); // no movement was ever posted, so no balance row exists at all
  });

  it("receiving more than was rejected-and-accepted (over-receive-then-reject) is allowed; only over-ACCEPTING is blocked", async () => {
    const { owner, po, warehouse } = await confirmedPo("grover", 10, 5);
    const poLine = po.lines[0];

    // Over-accepting is a hard block.
    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, warehouse.id, 15)] }), // acceptedQty 15 > ordered 10
    ).rejects.toThrow(/exceed the ordered quantity/);

    // Physically over-shipping and rejecting the excess at inspection is a legitimate receiving note.
    const result = await receiveGoodsForPurchaseOrder(owner, po.id, {
      clientRequestId: randomUUID(),
      lines: [grLine(poLine.id, warehouse.id, 15, 5)], // 15 received, 5 rejected, 10 accepted == ordered qty exactly
    });
    expect(result.replayed).toBe(false);
    const updated: any = await getPurchaseOrder(owner, po.id);
    expect(updated.status).toBe("received");
    expect(updated.lines[0].receivedQty).toBe("10");
  });

  it("a second over-accept attempt against an already-partially-accepted line is blocked by the remaining outstanding amount", async () => {
    const { owner, po, warehouse } = await confirmedPo("grover2", 10, 5);
    const poLine = po.lines[0];
    await receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, warehouse.id, 7)] });
    // 3 remain outstanding; accepting 4 more would exceed the ordered quantity.
    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, warehouse.id, 4)] }),
    ).rejects.toThrow(/exceed the ordered quantity/);
  });

  it("lot numbering is sequential per org across lines in the same submission and across separate receipts", async () => {
    const ctx = await setup("grlotseq");
    const item2 = await createItem(ctx.owner, { sku: `GR-MAT2-${Date.now()}`, itemType: "raw_material", name: "Second material", uom: "kg" });
    const draft = await createPurchaseOrder(ctx.owner, {
      branchId: ctx.org.branchId,
      supplierId: ctx.supplier.id,
      currency: "USD",
      lines: [line(ctx.material.id, 10, 5), line(item2.id, 10, 5)],
    });
    const po: any = await confirmPurchaseOrder(ctx.owner, draft.id);
    const l1 = po.lines.find((l: any) => l.itemId === ctx.material.id);
    const l2 = po.lines.find((l: any) => l.itemId === item2.id);

    const result = await receiveGoodsForPurchaseOrder(ctx.owner, po.id, {
      clientRequestId: randomUUID(),
      lines: [grLine(l1.id, ctx.warehouse.id, 10), grLine(l2.id, ctx.warehouse.id, 10)],
    });
    const lotNumbers = (result.receipt.lines as any[]).map((l) => l.lot.lotNumber).sort();
    expect(lotNumbers).toEqual(["LOT-000001", "LOT-000002"]);

    // A second, separate receipt in the same org continues the sequence (requires a fresh outstanding PO).
    const draft2 = await createPurchaseOrder(ctx.owner, { branchId: ctx.org.branchId, supplierId: ctx.supplier.id, currency: "USD", lines: [line(ctx.material.id, 5, 5)] });
    const po2: any = await confirmPurchaseOrder(ctx.owner, draft2.id);
    const result2 = await receiveGoodsForPurchaseOrder(ctx.owner, po2.id, { clientRequestId: randomUUID(), lines: [grLine(po2.lines[0].id, ctx.warehouse.id, 5)] });
    expect((result2.receipt.lines[0] as any).lot.lotNumber).toBe("LOT-000003");
  });

  it("merges duplicate poLineId submissions (one line split across two warehouses) for the over-accept check", async () => {
    const { owner, org, po, warehouse } = await confirmedPo("grsplit", 10, 5);
    const warehouse2 = await createWarehouse(owner, { branchId: org.branchId, name: "Second store" });
    const poLine = po.lines[0];

    // Split 6 + 6 = 12 accepted across two warehouses in ONE submission: must be blocked as a whole,
    // even though neither individual row alone exceeds the ordered quantity of 10.
    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, {
        clientRequestId: randomUUID(),
        lines: [grLine(poLine.id, warehouse.id, 6), grLine(poLine.id, warehouse2.id, 6)],
      }),
    ).rejects.toThrow(/exceed the ordered quantity/);

    // 5 + 5 = 10 fits exactly.
    const result = await receiveGoodsForPurchaseOrder(owner, po.id, {
      clientRequestId: randomUUID(),
      lines: [grLine(poLine.id, warehouse.id, 5), grLine(poLine.id, warehouse2.id, 5)],
    });
    expect(result.receipt.lines).toHaveLength(2);
    const updated: any = await getPurchaseOrder(owner, po.id);
    expect(updated.status).toBe("received");
  });
});

describe("goods receipts: validation", () => {
  it("rejects a mismatched acceptedQty+rejectedQty sum, a missing rejectReason, and a zero receivedQty", async () => {
    const { owner, po, warehouse } = await confirmedPo("grvalidate", 10, 5);
    const poLine = po.lines[0];
    const base = { clientRequestId: randomUUID() };

    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { ...base, lines: [{ poLineId: poLine.id, warehouseId: warehouse.id, receivedQty: 10, acceptedQty: 5, rejectedQty: 4 }] }),
    ).rejects.toThrow(/Invalid goods receipt/);

    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { ...base, lines: [{ poLineId: poLine.id, warehouseId: warehouse.id, receivedQty: 10, acceptedQty: 5, rejectedQty: 5 }] }),
    ).rejects.toThrow(/Invalid goods receipt/); // rejectedQty > 0 with no rejectReason

    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { ...base, lines: [{ poLineId: poLine.id, warehouseId: warehouse.id, receivedQty: 0, acceptedQty: 0, rejectedQty: 0 }] }),
    ).rejects.toThrow(/Invalid goods receipt/);

    await expect(receiveGoodsForPurchaseOrder(owner, po.id, { ...base, lines: [] })).rejects.toThrow(/Invalid goods receipt/);
    await expect(receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: "not-a-uuid", lines: [grLine(poLine.id, warehouse.id, 1)] })).rejects.toThrow(/Invalid goods receipt/);
  });

  it("rejects a poLineId that does not belong to the purchase order", async () => {
    const { owner, po, warehouse } = await confirmedPo("grwrongline", 10, 5);
    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(randomUUID(), warehouse.id, 1)] }),
    ).rejects.toThrow(/does not belong to this purchase order/);
  });

  it("rejects a warehouse that doesn't exist, one that is inactive, and one outside the PO's branch", async () => {
    const { owner, po, warehouse } = await confirmedPo("grwarehouse", 10, 5);
    const poLine = po.lines[0];

    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, randomUUID(), 1)] }),
    ).rejects.toThrow(/does not exist or is not accessible/);

    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { isActive: false } });
    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, warehouse.id, 1)] }),
    ).rejects.toThrow(/is inactive/);
    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { isActive: true } });

    const branch2 = await createBranch(owner, { name: "Elsewhere" });
    const whOtherBranch = await createWarehouse(owner, { branchId: branch2.id, name: "Other branch store" });
    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(poLine.id, whOtherBranch.id, 1)] }),
    ).rejects.toThrow(/not in this purchase order's branch/);
  });

  it("refuses to receive against a draft, a closed, or a cancelled purchase order", async () => {
    const draftCtx = await setup("grdraft");
    const draft = await createPurchaseOrder(draftCtx.owner, { branchId: draftCtx.org.branchId, supplierId: draftCtx.supplier.id, currency: "USD", lines: [line(draftCtx.material.id)] });
    await expect(
      receiveGoodsForPurchaseOrder(draftCtx.owner, draft.id, { clientRequestId: randomUUID(), lines: [grLine(draft.lines[0].id, draftCtx.warehouse.id, 1)] }),
    ).rejects.toThrow(/cannot receive goods/);

    const { owner, po, warehouse } = await confirmedPo("grclosed", 10, 5);
    const closed: any = await closePurchaseOrder(owner, po.id, { reason: "Supplier discontinued" });
    expect(closed.status).toBe("closed");
    await expect(
      receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 1)] }),
    ).rejects.toThrow(/cannot receive goods/);

    const cancelCtx = await confirmedPo("grcancelled", 10, 5);
    await cancelPurchaseOrder(cancelCtx.owner, cancelCtx.po.id, { reason: "No longer needed" });
    await expect(
      receiveGoodsForPurchaseOrder(cancelCtx.owner, cancelCtx.po.id, { clientRequestId: randomUUID(), lines: [grLine(cancelCtx.po.lines[0].id, cancelCtx.warehouse.id, 1)] }),
    ).rejects.toThrow(/cannot receive goods/);
  });
});

describe("goods receipts: idempotency", () => {
  it("replays a retried submission (same clientRequestId) instead of posting twice", async () => {
    const { owner, po, warehouse, material } = await confirmedPo("gridempotent", 10, 5);
    const poLine = po.lines[0];
    const clientRequestId = randomUUID();
    const payload = { clientRequestId, lines: [grLine(poLine.id, warehouse.id, 4)] };

    const first = await receiveGoodsForPurchaseOrder(owner, po.id, payload);
    expect(first.replayed).toBe(false);
    const second = await receiveGoodsForPurchaseOrder(owner, po.id, payload);
    expect(second.replayed).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);

    const b = await bal(owner, material.id, warehouse.id);
    expect(String(b.quantity)).toBe("4"); // posted exactly once despite the retry

    const receipts = await listGoodsReceiptsForPo(owner, po.id);
    expect(receipts).toHaveLength(1);
  });

  it("rejects reusing a clientRequestId against a different purchase order", async () => {
    const { owner, org, supplier, material, warehouse } = await setup("gridempotent2");
    const draftA = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    const poA: any = await confirmPurchaseOrder(owner, draftA.id);
    const draftB = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    const poB: any = await confirmPurchaseOrder(owner, draftB.id);

    const clientRequestId = randomUUID();
    await receiveGoodsForPurchaseOrder(owner, poA.id, { clientRequestId, lines: [grLine(poA.lines[0].id, warehouse.id, 1)] });
    await expect(receiveGoodsForPurchaseOrder(owner, poB.id, { clientRequestId, lines: [grLine(poB.lines[0].id, warehouse.id, 1)] })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("goods receipts: scope, capability matrix and cost visibility", () => {
  it("org B cannot read org A's goods receipt, and a user without access to the PO's branch gets NotFoundError (not Forbidden)", async () => {
    const { owner, org, po, warehouse } = await confirmedPo("grisoA", 10, 5);
    const result = await receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 10)] });

    const orgB = await createTestOrg("grisoB");
    const ownerB = await ownerSession(orgB);
    await expect(getGoodsReceipt(ownerB, result.receipt.id)).rejects.toBeInstanceOf(NotFoundError);

    const branch2 = await createBranch(owner, { name: "Other" });
    const otherBranchUser = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "gr-other-branch", [branch2.id]);
    await expect(getGoodsReceipt(otherBranchUser, result.receipt.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listGoodsReceiptsForPo(otherBranchUser, po.id)).rejects.toBeInstanceOf(NotFoundError); // the PO itself is out of scope
    await expect(
      receiveGoodsForPurchaseOrder(otherBranchUser, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 1)] }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("OPERATIONS_MANAGER and INVENTORY_MANAGER can create receipts (physically receiving is not a financial-commitment action)", async () => {
    const { owner, org, supplier, material, warehouse } = await setup("grcapcreate");
    for (const role of ["OPERATIONS_MANAGER", "INVENTORY_MANAGER"] as const) {
      const draft = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
      const po: any = await confirmPurchaseOrder(owner, draft.id); // confirm is Owner/Ops/etc. only -- INVENTORY_MANAGER never confirms its own PO here
      const session = await sessionWithRole(owner, org.organizationId, role, `gr-${role}`, [org.branchId]);
      await expect(
        receiveGoodsForPurchaseOrder(session, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 1)] }),
      ).resolves.toMatchObject({ replayed: false });
    }
  });

  it("PRODUCTION_MANAGER, FINANCE_MANAGER and VIEWER can read goods receipts but cannot create them", async () => {
    const { owner, org, po, warehouse } = await confirmedPo("grcapread", 10, 5);
    const result = await receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 5)] });

    const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "gr-prodmgr", [org.branchId]);
    const finMgr = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "gr-finmgr", [org.branchId]);
    const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "gr-viewer", [org.branchId]);

    for (const session of [prodMgr, finMgr, viewer]) {
      await expect(getGoodsReceipt(session, result.receipt.id)).resolves.toMatchObject({ id: result.receipt.id });
      await expect(listGoodsReceiptsForPo(session, po.id)).resolves.toHaveLength(1);
      await expect(
        receiveGoodsForPurchaseOrder(session, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 1)] }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("PRODUCTION_OPERATOR has no goods_receipt capability at all (cannot even read)", async () => {
    const { owner, org, po, warehouse } = await confirmedPo("grcapoperator", 10, 5);
    const result = await receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 5)] });
    const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "gr-operator", [org.branchId]);

    await expect(getGoodsReceipt(operator, result.receipt.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listGoodsReceiptsForPo(operator, po.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      receiveGoodsForPurchaseOrder(operator, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 1)] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("INVENTORY_MANAGER and VIEWER cannot see receipt-line unitCost/currency (cost:read withheld -- same roles purchase-order-service.test.ts confirms lack it)", async () => {
    const { owner, org, po, warehouse } = await confirmedPo("grcapcost", 10, 5);
    const result = await receiveGoodsForPurchaseOrder(owner, po.id, { clientRequestId: randomUUID(), lines: [grLine(po.lines[0].id, warehouse.id, 10)] });

    const asOwner: any = await getGoodsReceipt(owner, result.receipt.id);
    expect(asOwner.lines[0]).toHaveProperty("unitCost");
    expect(asOwner.lines[0]).toHaveProperty("currency");

    const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "gr-cost-inv", [org.branchId]);
    const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "gr-cost-viewer", [org.branchId]);
    for (const session of [invMgr, viewer]) {
      const asRole: any = await getGoodsReceipt(session, result.receipt.id);
      expect(asRole.lines[0]).not.toHaveProperty("unitCost");
      expect(asRole.lines[0]).not.toHaveProperty("currency");
    }
  });
});
