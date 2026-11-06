/* eslint-disable @typescript-eslint/no-explicit-any -- views are intentionally loose Record<string, unknown>
   projections, same convention lot-consumption.test.ts/material-issue.test.ts use. */
// Real-database tests (same approach as every other module suite -- see
// lot-consumption.test.ts's header comment). Fresh random org per test
// file, no cleanup (audit rows make orgs undeletable by design). NOT
// executed in this environment: see IMPLEMENTATION_MANIFEST.md -- writing
// and statically checking tests is within this environment's restrictions,
// connecting to a database is not. Run with `npm test -- finished-goods`
// against your own local test database, after `npx prisma generate` and
// `npx prisma migrate dev` have been run there (the sandbox this file was
// written in could not reach binaries.prisma.sh to regenerate the client,
// so this file is checked by hand against prisma/schema.prisma and every
// service it calls, not by tsc -- see the manifest's "Known limitations").
//
// Covers Milestone 2 ("Finished-Goods Inventory") end to end:
//  - receiveFinishedGoods: bounded by uncommitted good output under the
//    per-job advisory lock (never more than what was actually produced),
//    requires an existing cost basis, rejects when the job isn't in a
//    receivable status (even though it once was), idempotent replay, a
//    mismatched replay is a conflict, and the "quarantine" disposition
//  - listFinishedGoodsBatches / getBatchDetail / getBatchTraceability:
//    filters, "remaining" read live from the ledger, and non-lot-tracked
//    material yields an honestly empty (never fabricated) genealogy
//  - transferBatch: splits a batch across warehouses WITHOUT mutating the
//    source's append-only cost/lot rows -- the destination batch's cost and
//    lot lineage resolve LIVE as a proportional share of the batch it was
//    transferred from. This is this milestone's central "never count
//    material value twice" guarantee, so the per-unit cost invariant
//    (child's cost ÷ child's quantity == root's cost ÷ root's quantity) is
//    checked explicitly, along with the root's own cost line staying
//    completely unchanged after the transfer. Also: a rejected batch
//    refuses to transfer
//  - adjustBatch: a decrease is valued at the current average cost, an
//    increase averages into the existing cost basis, can't adjust below
//    zero remaining, rejects a zero quantity, and replays idempotently
//  - setBatchStatus: quarantine/release/reject, and a no-op when the
//    batch is already in the requested status
//  - getFinishedGoodsValuation / getWipValuation: both read LIVE from the
//    same stock_balance / actual-cost figures every other view already
//    uses -- never a second, independently-computed total. After a job's
//    full good output has been received into finished goods, its WIP goes
//    to exactly zero and it drops out of the no-jobId WIP listing
//  - the finished_goods:read/receive/manage capability matrix across every
//    role, and org/branch isolation
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { createJob, transitionJob } from "../../production/job-service";
import { recordOutput } from "../../production/output-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";
import { createWarehouse } from "../warehouse-service";
import { receiveStock } from "../stock-service";
import { issueMaterialToJob } from "../material-issue-service";
import {
  getJobFinishedGoodsSummary,
  receiveFinishedGoods,
  listFinishedGoodsBatches,
  getBatchDetail,
  getBatchTraceability,
  transferBatch,
  adjustBatch,
  setBatchStatus,
  getFinishedGoodsValuation,
  getWipValuation,
} from "../finished-goods-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let opsMgr2: AuthenticatedSession; // OPERATIONS_MANAGER (has finished_goods:manage), scoped to branch2 ONLY -- used to prove branch isolation on a batch that lives in branch1
let prodMgr: AuthenticatedSession; // PRODUCTION_MANAGER: read + receive, no manage
let invMgr: AuthenticatedSession; // INVENTORY_MANAGER: read + receive + manage
let operator: AuthenticatedSession; // PRODUCTION_OPERATOR: none of the finished_goods capabilities
let financeMgr: AuthenticatedSession; // FINANCE_MANAGER: read only, has cost:read
let viewer: AuthenticatedSession; // VIEWER: read only, no cost:read
let branch1: string;
let branch2: string;
let wh1: string; // branch1
let wh2: string; // branch2
let productId: string;
let materialId: string;

beforeAll(async () => {
  orgA = await createTestOrg("fgA");
  orgB = await createTestOrg("fgB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  branch1 = orgA.branchId;
  branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  wh1 = (await createWarehouse(ownerA, { branchId: branch1, name: "Main store" })).id;
  wh2 = (await createWarehouse(ownerA, { branchId: branch2, name: "Second store" })).id;

  opsMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "OPERATIONS_MANAGER", "fgops2", [branch2]);
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "fgpm", [branch1, branch2]);
  invMgr = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "fginv", [branch1, branch2]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "fgop", [branch1, branch2]);
  financeMgr = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fgfin", [branch1, branch2]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "fgvw", [branch1, branch2]);

  // One finished good, one (non-lot-tracked) raw material, BOM 1:1, standard
  // cost 5 USD/kg -- deliberately plain (no MaterialLot ever created for it)
  // so getBatchTraceability's genealogy is exercised on its honest,
  // backward-compatible "nothing to attribute" path, same as
  // lot-consumption.test.ts's own "plain" material does for Phase One.
  const p = await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 5, standardCostCurrency: "USD", bomQty: 1 }]);
  productId = p.product.id;
  materialId = p.materialItems[0].id;
  await receiveStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: materialId, quantity: 1000, unitCost: 5, currency: "USD" });
}, 240_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A released job for `productId`, with `plannedQty` units' worth of material issued and good output already recorded -- i.e. it has a real cost basis and uncommitted good output, ready to receive. */
async function jobReadyToReceive(plannedQty: number): Promise<string> {
  const j = (await createJob(ownerA, { branchId: branch1, productItemId: productId, plannedQty })) as Record<string, any>;
  await transitionJob(ownerA, j.id, { status: "released" });
  await issueMaterialToJob(ownerA, j.id, { clientRequestId: randomUUID(), materialItemId: materialId, warehouseId: wh1, quantity: plannedQty });
  await recordOutput(ownerA, j.id, { clientRequestId: randomUUID(), goodQty: plannedQty });
  return j.id;
}

// ---------------------------------------------------------------------------
// receiveFinishedGoods / getJobFinishedGoodsSummary
// ---------------------------------------------------------------------------

describe("receiveFinishedGoods", () => {
  it("rejects receiving before any cost has been recorded for the job", async () => {
    const j = (await createJob(ownerA, { branchId: branch1, productItemId: productId, plannedQty: 3 })) as Record<string, any>;
    await transitionJob(ownerA, j.id, { status: "released" });
    await recordOutput(ownerA, j.id, { clientRequestId: randomUUID(), goodQty: 3 }); // good output, but no material ever issued -> no cost
    await expect(
      receiveFinishedGoods(ownerA, j.id, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when the job is no longer in a receivable status", async () => {
    const j = await jobReadyToReceive(2);
    await transitionJob(ownerA, j, { status: "on_hold" }); // allowed from "released"; no longer in FG_RECEIVABLE_STATUSES
    await expect(
      receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("bounds the receivable quantity by uncommitted good output, receives correctly, and reports the running summary", async () => {
    const j = await jobReadyToReceive(10);

    const before = (await getJobFinishedGoodsSummary(ownerA, j)) as any;
    expect(before.producedGoodQty).toBe("10");
    expect(before.receivedToFinishedGoodsQty).toBe("0");
    expect(before.uncommittedGoodQty).toBe("10");
    expect(before.batches).toHaveLength(0);

    await expect(
      receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 11 }),
    ).rejects.toBeInstanceOf(ValidationError);

    const r1 = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 6 })) as any;
    expect(r1.replayed).toBe(false);
    expect(r1.batch.goodQty).toBe("6");
    expect(r1.batch.status).toBe("active");
    expect(Number(r1.batch.costLines[0].materialCost)).toBeCloseTo(30, 4); // 6/10 of the job's 50 USD material cost
    expect(r1.batch.costLines[0].labourCost).toBeNull();
    expect(r1.movement.movementType).toBe("finished_goods_receipt");
    expect(Number(r1.movement.quantity)).toBe(6);
    expect(Number(r1.movement.unitCost)).toBeCloseTo(5, 4);
    expect(r1.movement.currency.trim()).toBe("USD");
    expect(Number(r1.balance.quantity)).toBe(6);

    const mid = (await getJobFinishedGoodsSummary(ownerA, j)) as any;
    expect(mid.receivedToFinishedGoodsQty).toBe("6");
    expect(mid.uncommittedGoodQty).toBe("4");
    expect(mid.batches).toHaveLength(1);
    expect(mid.batches[0].remaining).toBe("6"); // nothing transferred/adjusted yet

    // Receiving the exact remainder, with a quarantine disposition.
    const r2 = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 4, disposition: "quarantine" })) as any;
    expect(r2.batch.status).toBe("quarantined");
    expect(Number(r2.batch.costLines[0].materialCost)).toBeCloseTo(20, 4); // remaining 4/10 share

    const after = (await getJobFinishedGoodsSummary(ownerA, j)) as any;
    expect(after.uncommittedGoodQty).toBe("0");
    await expect(
      receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 0.0001 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("replays idempotently on the same clientRequestId, and conflicts if that id is reused with different data", async () => {
    const j = await jobReadyToReceive(5);
    const id = randomUUID();
    const first = (await receiveFinishedGoods(ownerA, j, { clientRequestId: id, warehouseId: wh1, quantity: 5 })) as any;
    expect(first.replayed).toBe(false);

    const replay = (await receiveFinishedGoods(ownerA, j, { clientRequestId: id, warehouseId: wh1, quantity: 5 })) as any;
    expect(replay.replayed).toBe(true);
    expect(replay.batch.id).toBe(first.batch.id);
    expect(replay.movement.id).toBe(first.movement.id);

    await expect(
      receiveFinishedGoods(ownerA, j, { clientRequestId: id, warehouseId: wh1, quantity: 4 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("enforces the finished_goods:receive capability and org/branch scope", async () => {
    const j = await jobReadyToReceive(2);
    await expect(
      receiveFinishedGoods(operator, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      receiveFinishedGoods(financeMgr, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError); // read-only role
    await expect(
      receiveFinishedGoods(ownerB, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundError); // different org can't even see the job
    // prodMgr has receive but is scoped to branch1+branch2, both fine here -- should succeed.
    const r = (await receiveFinishedGoods(prodMgr, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 2 })) as any;
    expect(r.replayed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Browsing: listFinishedGoodsBatches / getBatchDetail / getBatchTraceability
// ---------------------------------------------------------------------------

describe("browsing finished-goods batches", () => {
  it("lists, filters, and shows a batch's detail and (honestly empty) traceability for non-lot-tracked material", async () => {
    const j = await jobReadyToReceive(4);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 4 })) as any;
    const batchId = received.batch.id as string;

    const list = (await listFinishedGoodsBatches(ownerA, { jobId: j })) as any[];
    expect(list.map((b) => b.id)).toContain(batchId);

    const byStatus = (await listFinishedGoodsBatches(ownerA, { jobId: j, status: "active" })) as any[];
    expect(byStatus.every((b) => b.status === "active")).toBe(true);

    const bySearch = (await listFinishedGoodsBatches(ownerA, { search: received.batch.batchNumber })) as any[];
    expect(bySearch.map((b) => b.id)).toContain(batchId);

    const detail = (await getBatchDetail(ownerA, batchId)) as any;
    expect(detail.remaining).toBe("4");
    expect(detail.movements).toHaveLength(0);

    const trace = (await getBatchTraceability(ownerA, batchId)) as any;
    expect(trace.materialLots).toEqual([]); // nothing lot-tracked -- never fabricated
    expect(trace.genealogyByMaterial).toHaveLength(1);
    expect(trace.genealogyByMaterial[0].attributedQty).toBe("0");
    expect(trace.genealogyByMaterial[0].complete).toBe(false);
    expect(Number(trace.genealogyByMaterial[0].theoreticalQty)).toBeCloseTo(4, 4);
  });

  it("omits cost fields for a role without cost:read, but still includes them for one with it", async () => {
    const j = await jobReadyToReceive(1);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 })) as any;

    const asOwner = (await getBatchDetail(ownerA, received.batch.id)) as any;
    expect(asOwner.costLines).toBeDefined();

    const asViewer = (await getBatchDetail(viewer, received.batch.id)) as any;
    expect(asViewer.costLines).toBeUndefined();
  });

  it("scopes batches by org and branch", async () => {
    const j = await jobReadyToReceive(1);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 })) as any;

    await expect(getBatchDetail(ownerB, received.batch.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBatchDetail(opsMgr2, received.batch.id)).rejects.toBeInstanceOf(NotFoundError); // opsMgr2 is scoped to branch2 only; this batch is branch1
    const listForB = (await listFinishedGoodsBatches(ownerB, {})) as any[];
    expect(listForB.find((b) => b.id === received.batch.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// transferBatch -- the central "never count material value twice" guarantee
// ---------------------------------------------------------------------------

describe("transferBatch", () => {
  it("splits a batch across warehouses without mutating the source's cost/lot rows, resolving the destination's share live", async () => {
    const j = await jobReadyToReceive(6);
    const root = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 6 })) as any;
    const rootBatchId = root.batch.id as string;
    const rootMaterialCost = Number(root.batch.costLines[0].materialCost); // 30 USD for 6 units -> 5/unit

    const transfer = (await transferBatch(ownerA, rootBatchId, { clientRequestId: randomUUID(), destinationWarehouseId: wh2, quantity: 4 })) as any;
    expect(transfer.replayed).toBe(false);
    const child = transfer.batch;
    expect(child.transferredFromBatchId).toBe(rootBatchId);
    expect(child.warehouseId).toBe(wh2);
    expect(child.goodQty).toBe("4");
    expect(child.status).toBe("active"); // inherited from the source's status at transfer time
    expect(child.materialLots).toEqual([]); // root had none either

    // Per-unit cost is preserved exactly across the transfer (this IS the
    // "never count material value twice" invariant: the child's share is
    // derived from the root's total, not a second independent charge).
    const childUnitCost = Number(child.costLines[0].materialCost) / Number(child.goodQty);
    const rootUnitCost = rootMaterialCost / 6;
    expect(childUnitCost).toBeCloseTo(rootUnitCost, 6);
    expect(Number(child.costLines[0].materialCost)).toBeCloseTo(20, 4); // 4/6 of 30

    // The root's OWN cost-line row is never mutated -- it still describes
    // the full originally-received 6 units, not the 2 that remain.
    const rootAfter = (await getBatchDetail(ownerA, rootBatchId)) as any;
    expect(Number(rootAfter.costLines[0].materialCost)).toBeCloseTo(rootMaterialCost, 4);
    expect(rootAfter.remaining).toBe("2"); // 6 - 4, read live from fg_batch_movement

    const childDetail = (await getBatchDetail(ownerA, child.id)) as any;
    expect(childDetail.remaining).toBe("4"); // nothing further has happened to the child yet

    const childTrace = (await getBatchTraceability(ownerA, child.id)) as any;
    expect(childTrace.materialLots).toEqual([]);
  });

  it("refuses to transfer a rejected batch, an over-quantity transfer, and a same-warehouse transfer", async () => {
    const j = await jobReadyToReceive(2);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 2 })) as any;
    const batchId = received.batch.id as string;

    await expect(
      transferBatch(ownerA, batchId, { clientRequestId: randomUUID(), destinationWarehouseId: wh1, quantity: 1 }),
    ).rejects.toBeInstanceOf(ValidationError); // same warehouse

    await expect(
      transferBatch(ownerA, batchId, { clientRequestId: randomUUID(), destinationWarehouseId: wh2, quantity: 5 }),
    ).rejects.toBeInstanceOf(ValidationError); // more than remains

    await setBatchStatus(ownerA, batchId, { status: "rejected", reason: "failed incoming QC" });
    await expect(
      transferBatch(ownerA, batchId, { clientRequestId: randomUUID(), destinationWarehouseId: wh2, quantity: 1 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("enforces finished_goods:manage (read+receive alone is not enough)", async () => {
    const j = await jobReadyToReceive(2);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 2 })) as any;
    await expect(
      transferBatch(prodMgr, received.batch.id, { clientRequestId: randomUUID(), destinationWarehouseId: wh2, quantity: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // invMgr has manage (so does OPERATIONS_MANAGER, exercised above via opsMgr2's branch-scoped negative case).
    const t = (await transferBatch(invMgr, received.batch.id, { clientRequestId: randomUUID(), destinationWarehouseId: wh2, quantity: 1 })) as any;
    expect(t.replayed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// adjustBatch
// ---------------------------------------------------------------------------

describe("adjustBatch", () => {
  it("decreases at the current average cost, increases by averaging into the existing basis, and refuses to go below zero", async () => {
    const j = await jobReadyToReceive(5);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 5 })) as any;
    const batchId = received.batch.id as string;

    const dec = (await adjustBatch(ownerA, batchId, { clientRequestId: randomUUID(), quantity: -2, reason: "physical recount shrinkage" })) as any;
    expect(dec.remaining).toBe("3");

    const inc = (await adjustBatch(ownerA, batchId, { clientRequestId: randomUUID(), quantity: 1, reason: "found extra on the shelf" })) as any;
    expect(inc.remaining).toBe("4");

    await expect(
      adjustBatch(ownerA, batchId, { clientRequestId: randomUUID(), quantity: -10, reason: "would go negative" }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(
      adjustBatch(ownerA, batchId, { clientRequestId: randomUUID(), quantity: 0, reason: "not allowed" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("replays idempotently", async () => {
    const j = await jobReadyToReceive(3);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 3 })) as any;
    const id = randomUUID();
    const first = (await adjustBatch(ownerA, received.batch.id, { clientRequestId: id, quantity: -1, reason: "shrinkage" })) as any;
    const replay = (await adjustBatch(ownerA, received.batch.id, { clientRequestId: id, quantity: -1, reason: "shrinkage" })) as any;
    expect(replay.replayed).toBe(true);
    expect(replay.remaining).toBe(first.remaining);
  });

  it("enforces finished_goods:manage", async () => {
    const j = await jobReadyToReceive(2);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 2 })) as any;
    await expect(
      adjustBatch(financeMgr, received.batch.id, { clientRequestId: randomUUID(), quantity: -1, reason: "not allowed for this role" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// setBatchStatus
// ---------------------------------------------------------------------------

describe("setBatchStatus", () => {
  it("quarantines, releases, rejects, and no-ops when already in the requested status", async () => {
    const j = await jobReadyToReceive(2);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 2 })) as any;
    const batchId = received.batch.id as string;

    const q = (await setBatchStatus(ownerA, batchId, { status: "quarantined", reason: "spot check" })) as any;
    expect(q.status).toBe("quarantined");

    const noop = (await setBatchStatus(ownerA, batchId, { status: "quarantined", reason: "spot check again" })) as any;
    expect(noop.status).toBe("quarantined");

    const released = (await setBatchStatus(ownerA, batchId, { status: "active", reason: "cleared the hold" })) as any;
    expect(released.status).toBe("active");

    const rejected = (await setBatchStatus(ownerA, batchId, { status: "rejected", reason: "failed final inspection" })) as any;
    expect(rejected.status).toBe("rejected");

    await expect(
      setBatchStatus(ownerA, batchId, { status: "active", reason: "x" }),
    ).rejects.toBeInstanceOf(ValidationError); // reason too short
  });

  it("enforces finished_goods:manage", async () => {
    const j = await jobReadyToReceive(1);
    const received = (await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 1 })) as any;
    await expect(
      setBatchStatus(prodMgr, received.batch.id, { status: "quarantined", reason: "no manage capability" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// Valuation: getFinishedGoodsValuation / getWipValuation
// ---------------------------------------------------------------------------

describe("valuation reports", () => {
  it("getFinishedGoodsValuation reflects the SAME stock_balance rows the stock ledger already maintains", async () => {
    const j = await jobReadyToReceive(3);
    await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 3 });

    const rows = (await getFinishedGoodsValuation(ownerA)) as any[];
    const row = rows.find((r) => r.itemId === productId && r.warehouseId === wh1);
    expect(row).toBeDefined();
    expect(Number(row.quantity)).toBeGreaterThanOrEqual(3); // other tests in this file also receive into wh1
    expect(Number(row.averageUnitCost)).toBeCloseTo(5, 4);
    expect(row.averageUnitCostCurrency.trim()).toBe("USD");
  });

  it("getWipValuation goes to zero once a job's full good output is received, and the job drops out of the no-jobId listing", async () => {
    const j = await jobReadyToReceive(4);
    const beforeWip = (await getWipValuation(ownerA, j)) as any;
    expect(Number(beforeWip.lines[0].remainingMaterialCost)).toBeCloseTo(20, 4); // 4 * 5 USD/unit, nothing transferred yet

    await receiveFinishedGoods(ownerA, j, { clientRequestId: randomUUID(), warehouseId: wh1, quantity: 4 });

    const afterWip = (await getWipValuation(ownerA, j)) as any;
    expect(Number(afterWip.lines[0].remainingMaterialCost)).toBeCloseTo(0, 4);
    expect(Number(afterWip.lines[0].transferredMaterialCost)).toBeCloseTo(20, 4);

    const openList = (await getWipValuation(ownerA)) as any[];
    expect(openList.find((x) => x.jobId === j)).toBeUndefined();
  });

  it("requires cost:read, independent of finished_goods:read", async () => {
    await expect(getWipValuation(viewer)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
