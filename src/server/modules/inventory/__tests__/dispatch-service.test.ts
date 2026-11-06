/* eslint-disable @typescript-eslint/no-explicit-any -- views are intentionally loose Record<string, unknown>
   projections, same convention finished-goods.test.ts/goods-receipt-service.test.ts use. */
// Real-database tests (same approach as every other module suite -- see
// finished-goods.test.ts's header comment). Fresh random org per test, no
// cleanup (audit rows make orgs undeletable by design). NOT executed in
// this environment: see IMPLEMENTATION_MANIFEST.md -- writing and
// statically checking tests is within this environment's restrictions,
// connecting to a database is not. Run with `npm test -- dispatch-service`
// against your own local test database, after `npx prisma generate` and
// `npx prisma migrate dev` have been run there (the sandbox this file was
// written in could not reach binaries.prisma.sh to regenerate the client,
// so this file is checked by hand against prisma/schema.prisma and every
// service it calls, not by tsc -- see the manifest's "Known limitations").
//
// Covers Milestone 3 ("Dispatch and Delivery") end to end:
//  - createDispatch: auto-FIFO allocation across ACTIVE finished-goods
//    batches (oldest producedAt first), explicit batchAllocations (must
//    sum exactly to the line quantity, no duplicate batch, must be an
//    active batch of this item in this warehouse), refuses quarantined/
//    rejected batches outright, refuses insufficient stock, refuses
//    over-dispatch against the order line (merging duplicate line
//    submissions), recomputes the order's status (partially_delivered /
//    delivered), posts exactly one StockMovement per batch allocation and
//    decrements the warehouse balance, and is idempotent on
//    clientRequestId -- including the "only the very first movement across
//    the WHOLE submission carries the real key" detail, a real bug fixed
//    during this milestone's own development (see the manifest's "Errors
//    and fixes")
//  - two lines of the SAME item in one dispatch sharing the same batch
//    pool without double-dipping (the shared in-memory remaining map)
//  - confirmDelivery: pure metadata, idempotent, never touches stock or
//    the sales order's status
//  - listDispatches / listDispatchesForOrder / getDispatch: filters and
//    cost-of-goods visibility gated by cost:read
//  - the dispatch:read / dispatch:create capability matrix across every
//    role, and org/branch isolation
//  - cancelSalesOrder is blocked once a dispatch exists against the order
//    (the Milestone 3 addition to sales-order-service.ts)
//  - getBatchTraceability's forward chain now reports the dispatch (the
//    Milestone 2 -> Milestone 3 seam)
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { createCustomer } from "../../customers/customer-service";
import { createJob, transitionJob } from "../../production/job-service";
import { recordOutput } from "../../production/output-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";
import { createWarehouse } from "../warehouse-service";
import { receiveStock, listStockBalances } from "../stock-service";
import { issueMaterialToJob } from "../material-issue-service";
import { receiveFinishedGoods, setBatchStatus, getBatchDetail, getBatchTraceability } from "../finished-goods-service";
import { createSalesOrder, confirmSalesOrder, getSalesOrder, cancelSalesOrder } from "../../sales/sales-order-service";
import { createDispatch, confirmDelivery, getDispatch, listDispatches, listDispatchesForOrder } from "../dispatch-service";
import { prisma } from "../../../shared/db";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setup(label: string) {
  const org: TestOrg = await createTestOrg(label);
  const owner = await ownerSession(org);
  const customer = await createCustomer(owner, { name: `Customer ${label}` });
  const warehouse = await createWarehouse(owner, { branchId: org.branchId, name: `WH ${label}` });
  // Product uom is always "ea" (production-helpers.ts's productWithActiveBom
  // fixes it), bomQty 1 of a plain non-lot-tracked "kg" material -- same
  // deliberately plain setup finished-goods.test.ts uses, since dispatch's
  // own picking logic doesn't care about material lineage at all.
  const { product, materialItems } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 5, standardCostCurrency: "USD", bomQty: 1 }]);
  const materialId = materialItems[0]!.id;
  await receiveStock(owner, { clientRequestId: randomUUID(), warehouseId: warehouse.id, itemId: materialId, quantity: 10_000, unitCost: 5, currency: "USD" });
  return { org, owner, customer, warehouse, product, materialId };
}

/** Produces and receives `qty` good units of `productId` into an ACTIVE finished-goods batch in `warehouse`, optionally at a specific `occurredAt` (for deterministic FIFO ordering). */
async function fgBatch(
  owner: AuthenticatedSession,
  branchId: string,
  warehouse: { id: string },
  productId: string,
  materialId: string,
  qty: number,
  occurredAt?: Date,
) {
  const j = (await createJob(owner, { branchId, productItemId: productId, plannedQty: qty })) as Record<string, any>;
  await transitionJob(owner, j.id, { status: "released" });
  await issueMaterialToJob(owner, j.id, { clientRequestId: randomUUID(), materialItemId: materialId, warehouseId: warehouse.id, quantity: qty });
  await recordOutput(owner, j.id, { clientRequestId: randomUUID(), goodQty: qty });
  const r: any = await receiveFinishedGoods(owner, j.id, {
    clientRequestId: randomUUID(),
    warehouseId: warehouse.id,
    quantity: qty,
    ...(occurredAt ? { occurredAt } : {}),
  });
  return r.batch as { id: string; batchNumber: string; goodQty: string; status: string; producedAt: string };
}

const soLine = (itemId: string, quantity = 5, unitPrice = 10) => ({ itemId, quantity, unitPrice });

/** A confirmed single-line sales order for `qty` of `productId`. */
async function confirmedOrder(owner: AuthenticatedSession, org: TestOrg, customerId: string, productId: string, qty: number, unitPrice = 10) {
  const draft: any = await createSalesOrder(owner, { branchId: org.branchId, customerId, currency: "USD", lines: [soLine(productId, qty, unitPrice)] });
  return (await confirmSalesOrder(owner, draft.id)) as any;
}

const dLine = (salesOrderLineId: string, quantity: number, batchAllocations?: { batchId: string; quantity: number }[]) => ({
  salesOrderLineId,
  quantity,
  ...(batchAllocations ? { batchAllocations } : {}),
});

const balance = async (session: AuthenticatedSession, itemId: string, warehouseId: string) => {
  const rows = (await listStockBalances(session, { itemId, warehouseId })) as any[];
  return rows[0];
};

// ---------------------------------------------------------------------------
// Picking and stock
// ---------------------------------------------------------------------------

describe("createDispatch: picking and stock", () => {
  it("auto-FIFO picks the oldest produced batch first, splitting across batches as needed", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsfifo");
    const older = await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 3, new Date("2026-01-01T00:00:00Z"));
    const newer = await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 4, new Date("2026-01-02T00:00:00Z"));
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);

    const result = await createDispatch(owner, order.id, {
      clientRequestId: randomUUID(),
      warehouseId: warehouse.id,
      lines: [dLine(order.lines[0].id, 5)],
    });
    expect(result.replayed).toBe(false);
    const allocations = (result.dispatch as any).lines[0].batchAllocations;
    expect(allocations).toEqual([
      { batchId: older.id, batchNumber: older.batchNumber, quantity: "3" },
      { batchId: newer.id, batchNumber: newer.batchNumber, quantity: "2" },
    ]);

    expect((await getBatchDetail(owner, older.id)).remaining).toBe("0");
    expect((await getBatchDetail(owner, newer.id)).remaining).toBe("2");
    const b = await balance(owner, product.id, warehouse.id);
    expect(String(b.quantity)).toBe("2"); // 3 + 4 produced/received - 5 dispatched
  });

  it("explicit batchAllocations must sum exactly to the line quantity, rejects a duplicate batch and an ineligible one", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsexplicit");
    const batch = await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const lineId = order.lines[0].id;

    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 5, [{ batchId: batch.id, quantity: 4 }])] }),
    ).rejects.toThrow(/must sum exactly/);

    await expect(
      createDispatch(owner, order.id, {
        clientRequestId: randomUUID(),
        warehouseId: warehouse.id,
        lines: [dLine(lineId, 5, [{ batchId: batch.id, quantity: 2 }, { batchId: batch.id, quantity: 3 }])],
      }),
    ).rejects.toThrow(/can only appear once/);

    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 5, [{ batchId: randomUUID(), quantity: 5 }])] }),
    ).rejects.toThrow(/not an active finished-goods batch/);

    const ok = await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 5, [{ batchId: batch.id, quantity: 5 }])] });
    expect(ok.replayed).toBe(false);
  });

  it("refuses to pick a quarantined or a rejected batch, even when it is the only stock available", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsquarantine");
    const batch = await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const lineId = order.lines[0].id;

    await setBatchStatus(owner, batch.id, { status: "quarantined", reason: "Pending QA recheck" });
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 5)] }),
    ).rejects.toThrow(/Insufficient active finished-goods stock/);
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 5, [{ batchId: batch.id, quantity: 5 }])] }),
    ).rejects.toThrow(/not an active finished-goods batch/);

    await setBatchStatus(owner, batch.id, { status: "rejected", reason: "Failed final inspection" });
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 5)] }),
    ).rejects.toThrow(/Insufficient active finished-goods stock/);
  });

  it("refuses when there isn't enough active stock, naming the shortfall", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsshort");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 3);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 5)] }),
    ).rejects.toThrow(/2 ea short/);
  });

  it("two lines of the same item in one dispatch share the same batch pool without double-dipping", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsshared");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 5);
    const draft: any = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [soLine(product.id, 3, 10), soLine(product.id, 2, 10)] });
    const order: any = await confirmSalesOrder(owner, draft.id);
    // order.lines is ordered by its (random UUID) line id, NOT submission
    // order -- find each line by its own distinct ordered quantity instead
    // of assuming array position.
    const line3 = order.lines.find((l: any) => l.quantity === "3");
    const line2 = order.lines.find((l: any) => l.quantity === "2");

    const result = await createDispatch(owner, order.id, {
      clientRequestId: randomUUID(),
      warehouseId: warehouse.id,
      lines: [dLine(line3.id, 3), dLine(line2.id, 2)],
    });
    expect(result.replayed).toBe(false);
    const b = await balance(owner, product.id, warehouse.id);
    expect(String(b.quantity)).toBe("0"); // exactly 5 consumed across both lines, never double-counted
  });
});

// ---------------------------------------------------------------------------
// Order integration
// ---------------------------------------------------------------------------

describe("createDispatch: order integration", () => {
  it("requires a confirmed (or later) order; refuses a draft and a cancelled order", async () => {
    const { org, owner, customer, warehouse, product } = await setup("dsstatus");
    const draft: any = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [soLine(product.id, 1, 10)] });
    await expect(
      createDispatch(owner, draft.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(draft.lines[0].id, 1)] }),
    ).rejects.toThrow(/cannot be dispatched/);

    const confirmed: any = await confirmSalesOrder(owner, draft.id);
    await cancelSalesOrder(owner, confirmed.id, { reason: "changed mind" });
    await expect(
      createDispatch(owner, confirmed.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(confirmed.lines[0].id, 1)] }),
    ).rejects.toThrow(/cannot be dispatched/);
  });

  it("rejects dispatching more than the line's ordered quantity, across separate dispatches", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsover");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const lineId = order.lines[0].id;

    await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 3)] });
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 3)] }),
    ).rejects.toThrow(/only 2 remains outstanding/);
    await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 2)] });
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 1)] }),
    ).rejects.toThrow(/only 0 remains outstanding/);
  });

  it("recomputes order status: partially_delivered after a partial dispatch, delivered once everything has shipped", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsstatusflow");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const lineId = order.lines[0].id;

    await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 2)] });
    expect(((await getSalesOrder(owner, order.id)) as any).status).toBe("partially_delivered");

    await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 3)] });
    expect(((await getSalesOrder(owner, order.id)) as any).status).toBe("delivered");
  });

  it("rejects a salesOrderLineId that does not belong to the order", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dswrongline");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(randomUUID(), 1)] }),
    ).rejects.toThrow(/does not belong to this order/);
  });

  it("rejects an inactive warehouse and one outside the order's branch", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dswarehouse");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const lineId = order.lines[0].id;

    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { isActive: false } });
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(lineId, 1)] }),
    ).rejects.toThrow(/inactive warehouse/);
    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { isActive: true } });

    const branch2 = await createBranch(owner, { name: "Elsewhere" });
    const whOther = await createWarehouse(owner, { branchId: branch2.id, name: "Other branch store" });
    await expect(
      createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: whOther.id, lines: [dLine(lineId, 1)] }),
    ).rejects.toThrow(/same branch as the order/);
  });

  it("blocks cancelling an order once a dispatch exists against it", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dscancelblock");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 2)] });
    await expect(cancelSalesOrder(owner, order.id, { reason: "too late" })).rejects.toThrow(/already been dispatched/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("createDispatch: idempotency", () => {
  it("replays a retried multi-line submission (same clientRequestId) instead of posting twice", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsidempotent");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const draft: any = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [soLine(product.id, 3, 10), soLine(product.id, 2, 10)] });
    const order: any = await confirmSalesOrder(owner, draft.id);
    // See the "two lines of the same item" test above for why these are
    // looked up by quantity rather than assumed array position.
    const line3 = order.lines.find((l: any) => l.quantity === "3");
    const line2 = order.lines.find((l: any) => l.quantity === "2");
    const clientRequestId = randomUUID();
    const payload = { clientRequestId, warehouseId: warehouse.id, lines: [dLine(line3.id, 3), dLine(line2.id, 2)] };

    const first = await createDispatch(owner, order.id, payload);
    expect(first.replayed).toBe(false);
    const second = await createDispatch(owner, order.id, payload);
    expect(second.replayed).toBe(true);
    expect((second.dispatch as any).id).toBe((first.dispatch as any).id);

    // Posted exactly once despite the retry, across BOTH lines (this is the
    // regression test for the "primaryClientRequestIdUsed reset per-line"
    // bug fixed during this milestone -- a naive per-line reset would have
    // tried to insert a second StockMovement with the same clientRequestId
    // on the second line and thrown a unique-constraint error instead of
    // replaying cleanly).
    const b = await balance(owner, product.id, warehouse.id);
    expect(String(b.quantity)).toBe("5"); // 10 produced - 5 dispatched, exactly once
    expect((await listDispatchesForOrder(owner, order.id))).toHaveLength(1);
  });

  it("rejects reusing a clientRequestId already consumed by an unrelated stock movement", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsidempotent2");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const clientRequestId = randomUUID();
    await receiveStock(owner, { clientRequestId, warehouseId: warehouse.id, itemId: materialId, quantity: 1, unitCost: 5, currency: "USD" });
    await expect(
      createDispatch(owner, order.id, { clientRequestId, warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 5)] }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// confirmDelivery
// ---------------------------------------------------------------------------

describe("confirmDelivery", () => {
  it("records delivery metadata without moving stock or changing the order's status, and is idempotent", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dsdeliver");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const { dispatch } = await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 5)] });
    const d = dispatch as any;
    expect(d.status).toBe("dispatched");

    const balBefore = await balance(owner, product.id, warehouse.id);
    const orderStatusBefore = ((await getSalesOrder(owner, order.id)) as any).status;

    const confirmed: any = await confirmDelivery(owner, d.id, { receivedBy: "J. Smith", deliveryNotes: "Left at loading dock" });
    expect(confirmed.status).toBe("delivered");
    expect(confirmed.receivedBy).toBe("J. Smith");
    expect(confirmed.deliveryNotes).toBe("Left at loading dock");
    expect(confirmed.deliveredAt).toBeTruthy();

    const balAfter = await balance(owner, product.id, warehouse.id);
    expect(String(balAfter.quantity)).toBe(String(balBefore.quantity)); // no stock movement
    expect(((await getSalesOrder(owner, order.id)) as any).status).toBe(orderStatusBefore); // order status untouched

    // Idempotent: confirming again is a no-op, not an error.
    const again: any = await confirmDelivery(owner, d.id, { receivedBy: "Someone else" });
    expect(again.status).toBe("delivered");
    expect(again.receivedBy).toBe("J. Smith"); // the FIRST confirmation's values stick
  });

  it("rejects confirming a dispatch that doesn't exist or is out of the caller's scope", async () => {
    const { owner } = await setup("dsdeliver404");
    await expect(confirmDelivery(owner, randomUUID(), {})).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("listing and cost visibility", () => {
  it("getDispatch / listDispatches / listDispatchesForOrder filter correctly, and cost:read gates costOfGoodsDispatched", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dslist");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const { dispatch } = await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 5)] });
    const d = dispatch as any;

    expect((await getDispatch(owner, d.id)).costOfGoodsDispatched).toBeDefined();
    expect((await listDispatches(owner, { salesOrderId: order.id })).rows).toHaveLength(1);
    expect((await listDispatches(owner, { warehouseId: warehouse.id })).rows).toHaveLength(1);
    expect((await listDispatches(owner, { status: "delivered" })).rows).toHaveLength(0);
    expect((await listDispatches(owner, { search: d.dispatchNumber })).rows).toHaveLength(1);
    expect((await listDispatches(owner, { search: order.orderNumber })).total).toBe(1);
    expect(await listDispatchesForOrder(owner, order.id)).toHaveLength(1);

    const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "ds-list-viewer", [org.branchId]);
    const asViewer: any = await getDispatch(viewer, d.id);
    expect(asViewer.costOfGoodsDispatched).toBeUndefined();
    expect(asViewer.costNote).toBeUndefined();
  });

  it("getBatchTraceability's forward chain reports the dispatch and (when sales_order:read is held) the order/customer", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dstrace");
    const batch = await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const { dispatch } = await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 5)] });
    const d = dispatch as any;

    const trace: any = await getBatchTraceability(owner, batch.id);
    expect(trace.dispatches).toHaveLength(1);
    expect(trace.dispatches[0].dispatchId).toBe(d.id);
    expect(trace.dispatches[0].quantity).toBe("5");
    expect(trace.dispatches[0].orderNumber).toBe(order.orderNumber); // owner has sales_order:read
    expect(trace.dispatches[0].customerName).toBe(customer.name);
    expect(trace.forwardChainNote).toMatch(/1 dispatch/);
  });
});

// ---------------------------------------------------------------------------
// Authorization and isolation
// ---------------------------------------------------------------------------

describe("createDispatch / dispatch reads: authorization and isolation", () => {
  it("enforces the dispatch:read / dispatch:create capability matrix across every role", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("dscaps");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 20);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 10);
    const { dispatch } = await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 2)] });
    const d = dispatch as any;

    const opsMgr = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "ds-ops", [org.branchId]);
    const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "ds-pm", [org.branchId]);
    const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "ds-inv", [org.branchId]);
    const financeMgr = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "ds-fin", [org.branchId]);
    const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "ds-view", [org.branchId]);
    const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "ds-op", [org.branchId]);

    // dispatch:read: everyone except PRODUCTION_OPERATOR.
    for (const session of [opsMgr, prodMgr, invMgr, financeMgr, viewer]) {
      await expect(getDispatch(session, d.id)).resolves.toMatchObject({ id: d.id });
    }
    await expect(getDispatch(operator, d.id)).rejects.toBeInstanceOf(ForbiddenError);

    // dispatch:create: OWNER_ADMIN, OPERATIONS_MANAGER, INVENTORY_MANAGER only.
    for (const session of [opsMgr, invMgr]) {
      await expect(
        createDispatch(session, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 1)] }),
      ).resolves.toMatchObject({ replayed: false });
    }
    for (const session of [prodMgr, financeMgr, viewer, operator]) {
      await expect(
        createDispatch(session, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 1)] }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }

    // confirmDelivery rides the same dispatch:create capability -- no separate confirm capability.
    await expect(confirmDelivery(prodMgr, d.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(confirmDelivery(invMgr, d.id, {})).resolves.toMatchObject({ status: "delivered" });
  });

  it("never discloses another organization's dispatch", async () => {
    const a = await setup("ds-org-a");
    await fgBatch(a.owner, a.org.branchId, a.warehouse, a.product.id, a.materialId, 10);
    const order = await confirmedOrder(a.owner, a.org, a.customer.id, a.product.id, 5);
    const { dispatch } = await createDispatch(a.owner, order.id, { clientRequestId: randomUUID(), warehouseId: a.warehouse.id, lines: [dLine(order.lines[0].id, 5)] });
    const d = dispatch as any;

    const b = await setup("ds-org-b");
    await expect(getDispatch(b.owner, d.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(confirmDelivery(b.owner, d.id, {})).rejects.toBeInstanceOf(NotFoundError);
    expect((await listDispatches(b.owner)).total).toBe(0);
  });

  it("scopes dispatches and dispatch creation to the caller's branches (not-found/no-access, never forbidden-by-surprise)", async () => {
    const { org, owner, customer, warehouse, product, materialId } = await setup("ds-branch");
    await fgBatch(owner, org.branchId, warehouse, product.id, materialId, 10);
    const order = await confirmedOrder(owner, org, customer.id, product.id, 5);
    const { dispatch } = await createDispatch(owner, order.id, { clientRequestId: randomUUID(), warehouseId: warehouse.id, lines: [dLine(order.lines[0].id, 5)] });
    const d = dispatch as any;

    const branch2 = await createBranch(owner, { name: "Elsewhere" });
    const otherBranchUser = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "ds-other-branch", [branch2.id]);
    await expect(getDispatch(otherBranchUser, d.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listDispatchesForOrder(otherBranchUser, order.id)).rejects.toBeInstanceOf(NotFoundError); // the order itself is out of scope
    expect((await listDispatches(otherBranchUser)).total).toBe(0);
  });
});
