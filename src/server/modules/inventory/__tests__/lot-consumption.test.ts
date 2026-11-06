/* eslint-disable @typescript-eslint/no-explicit-any -- views are intentionally loose Record<string, unknown>
   projections, same convention material-issue.test.ts/goods-receipt-service.test.ts use. */
// Real-database tests (same approach as every other module suite -- see
// material-issue.test.ts's and goods-receipt-service.test.ts's header
// comments). Fresh random org per test file, no cleanup (audit rows make
// orgs undeletable by design). NOT executed in this environment: see
// IMPLEMENTATION_MANIFEST.md -- writing and statically checking tests is
// within this environment's restrictions, connecting to a database is not.
// Run with `npm test -- lot-consumption` against your local test database.
//
// Covers Phase One ("Complete Lot Traceability") end to end:
//  - auto-FEFO allocation and its spillover across lots, and explicit
//    lotAllocations overriding FEFO
//  - expired/quarantined lots are never drawn from, by auto-FEFO or by
//    explicit override, even when the warehouse's PHYSICAL balance would
//    otherwise be sufficient (the quarantine-vs-physical-stock distinction
//    the mandate's accounting requirement turns on)
//  - one lot serving multiple jobs, and partial consumption/remaining
//    correctness, including under real concurrent contention for the same
//    lot (lockLots' advisory-lock serialization)
//  - returns: "good" disposition credits back to the original lot at a
//    correctly WEIGHTED (not simple-averaged) per-lot cost basis across
//    multiple consumption events at different stamped costs; "quarantine"
//    disposition spawns a new, linked, non-consumable lot and leaves the
//    original lot's balance untouched
//  - lot-service.ts's read endpoints, its lot:read/lot:manage capability
//    split (and that PRODUCTION_OPERATOR can still issue/return lot-tracked
//    material via auto-allocation without lot:read), and org/branch isolation
//  - backward compatibility for items never lot-tracked in a warehouse
//  - the two reconciliation invariants documented in this round's migration
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { prisma } from "../../../shared/db";
import { createJob, getJob, transitionJob } from "../../production/job-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";
import { createWarehouse } from "../warehouse-service";
import { createSupplier } from "../../suppliers/supplier-service";
import { createPurchaseOrder, confirmPurchaseOrder } from "../../purchasing/purchase-order-service";
import { receiveGoodsForPurchaseOrder } from "../../purchasing/goods-receipt-service";
import { receiveStock, listStockBalances } from "../stock-service";
import { issueMaterialToJob, returnMaterialFromJob, getJobMaterials } from "../material-issue-service";
import {
  listLots,
  getAvailableLotsForIssue,
  getLotDetail,
  getLotTraceability,
  setLotStatus,
  getJobLotConsumption,
} from "../lot-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let opsMgr: AuthenticatedSession;
let opsMgr2: AuthenticatedSession; // branch 2 only
let prodMgr: AuthenticatedSession;
let prodMgr2: AuthenticatedSession; // branch 2 only
let operator: AuthenticatedSession;
let viewer: AuthenticatedSession;
let finance: AuthenticatedSession;
let inv: AuthenticatedSession;
let wh1: string;
let wh2: string;
let supplier: Record<string, any>;
let plainProductId: string;
let plainMaterialId: string;

beforeAll(async () => {
  orgA = await createTestOrg("lotA");
  orgB = await createTestOrg("lotB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  wh1 = (await createWarehouse(ownerA, { branchId: orgA.branchId, name: "Main store" })).id;
  wh2 = (await createWarehouse(ownerA, { branchId: branch2, name: "Second store" })).id;
  supplier = await createSupplier(ownerA, { name: "Lot Supplier" });

  opsMgr = await sessionWithRole(ownerA, orgA.organizationId, "OPERATIONS_MANAGER", "ops", [orgA.branchId]);
  opsMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "OPERATIONS_MANAGER", "ops2", [branch2]);
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
  prodMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm2", [branch2]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "vw", [orgA.branchId]);
  finance = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fm", [orgA.branchId]);
  inv = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "inv", [orgA.branchId]);

  // A material that is NEVER lot-tracked (no MaterialLot row ever created for
  // it), received the plain way -- proves the lot machinery is a true no-op
  // for every pre-existing caller.
  const plain = await productWithActiveBom(ownerA, [{ uom: "ea", standardCost: 2, standardCostCurrency: "USD", bomQty: 1 }]);
  plainProductId = plain.product.id;
  plainMaterialId = plain.materialItems[0].id;
  await receiveStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: plainMaterialId, quantity: 100, unitCost: 2, currency: "USD" });
}, 240_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function job(productItemId: string, status: "planned" | "released" = "released", plannedQty = 1): Promise<string> {
  const j = (await createJob(ownerA, { branchId: orgA.branchId, productItemId, plannedQty })) as Record<string, any>;
  if (status === "released") await transitionJob(ownerA, j.id, { status: "released" });
  return j.id;
}

/** A fresh finished good + raw material + ACTIVE BOM, isolated from every other test's lot pool. */
async function freshLotMaterial(): Promise<{ productId: string; itemId: string }> {
  const p = await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 5, standardCostCurrency: "USD", bomQty: 1 }]);
  return { productId: p.product.id, itemId: p.materialItems[0].id };
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

/** Receives a fresh PO line in full, which creates exactly one new MaterialLot. */
async function receiveLot(
  itemId: string,
  quantity = 10,
  unitPrice = 5,
  opts: { expiryDate?: string; supplierLotRef?: string; warehouseId?: string } = {},
): Promise<Record<string, any>> {
  const warehouseId = opts.warehouseId ?? wh1;
  const draft = await createPurchaseOrder(ownerA, {
    branchId: orgA.branchId,
    supplierId: supplier.id,
    currency: "USD",
    lines: [{ itemId, quantity, uom: "kg", unitPrice }],
  });
  const po = (await confirmPurchaseOrder(ownerA, draft.id)) as Record<string, any>;
  const result = (await receiveGoodsForPurchaseOrder(ownerA, po.id, {
    clientRequestId: randomUUID(),
    lines: [
      grLine(po.lines[0].id, warehouseId, quantity, 0, {
        ...(opts.expiryDate ? { expiryDate: opts.expiryDate } : {}),
        ...(opts.supplierLotRef ? { supplierLotRef: opts.supplierLotRef } : {}),
      }),
    ],
  })) as Record<string, any>;
  return result.receipt.lines[0].lot;
}

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const issuePayload = (materialItemId: string, over: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  materialItemId,
  warehouseId: wh1,
  quantity: 1,
  ...over,
});
const returnPayload = (materialItemId: string, over: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  materialItemId,
  warehouseId: wh1,
  quantity: 1,
  reason: "test return",
  ...over,
});

// ---------------------------------------------------------------------------

describe("lot allocation on issue", () => {
  it("auto-FEFO draws the earliest-expiring lot first, then spills over to the next", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const laterExpiry = await receiveLot(itemId, 10, 5, { expiryDate: isoDate(30) });
    const soonerExpiry = await receiveLot(itemId, 10, 5, { expiryDate: isoDate(5) }); // received SECOND but expires SOONER
    const jobId = await job(pid);

    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 6 }));
    let rows = (await getJobLotConsumption(ownerA, jobId)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].lotId).toBe(soonerExpiry.id);
    expect(String(rows[0].consumed)).toBe("6");

    // Second issue spills over: sooner-expiry lot only has 4 left, the rest comes from the later-expiry lot.
    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 6 }));
    rows = (await getJobLotConsumption(ownerA, jobId)) as any[];
    expect(rows.find((r) => r.lotId === soonerExpiry.id)?.consumed.toString()).toBe("10");
    expect(rows.find((r) => r.lotId === laterExpiry.id)?.consumed.toString()).toBe("2");
  });

  it("explicit lotAllocations overrides FEFO and draws only from the named lot(s)", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const fefoPreferred = await receiveLot(itemId, 10, 5, { expiryDate: isoDate(5) });
    const fefoNotPreferred = await receiveLot(itemId, 10, 5, { expiryDate: isoDate(30) });
    const jobId = await job(pid);

    await issueMaterialToJob(
      ownerA,
      jobId,
      issuePayload(itemId, { quantity: 4, lotAllocations: [{ lotId: fefoNotPreferred.id, quantity: 4 }] }),
    );
    const rows = (await getJobLotConsumption(ownerA, jobId)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].lotId).toBe(fefoNotPreferred.id);
    const detail = await getLotDetail(ownerA, fefoPreferred.id);
    expect(String(detail.remaining)).toBe("10"); // untouched
  });

  it("explicit lotAllocations: must sum exactly, no duplicate lot, must belong to this item/warehouse, and cannot exceed remaining", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 5);
    const jobId = await job(pid);
    const { itemId: foreignItemId } = await freshLotMaterial();
    const foreignLot = await receiveLot(foreignItemId, 10, 5);

    await expect(
      issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 5, lotAllocations: [{ lotId: lot.id, quantity: 4 }] })),
    ).rejects.toBeInstanceOf(ValidationError); // sum (4) != quantity (5)
    await expect(
      issueMaterialToJob(
        ownerA,
        jobId,
        issuePayload(itemId, { quantity: 5, lotAllocations: [{ lotId: lot.id, quantity: 3 }, { lotId: lot.id, quantity: 2 }] }),
      ),
    ).rejects.toBeInstanceOf(ValidationError); // duplicate lot
    await expect(
      issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 5, lotAllocations: [{ lotId: foreignLot.id, quantity: 5 }] })),
    ).rejects.toBeInstanceOf(ValidationError); // not a lot of this item/warehouse
    await expect(
      issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 50, lotAllocations: [{ lotId: lot.id, quantity: 50 }] })),
    ).rejects.toBeInstanceOf(ValidationError); // exceeds remaining
  });

  it("an expired or quarantined lot is never drawn from by auto-FEFO, and is refused by explicit override", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const expired = await receiveLot(itemId, 10, 5, { expiryDate: isoDate(-1) });
    const quarantined = await receiveLot(itemId, 10, 5);
    await setLotStatus(inv, quarantined.id, { status: "quarantined", reason: "supplier recall" });
    const good = await receiveLot(itemId, 10, 5, { expiryDate: isoDate(30) });
    const jobId = await job(pid);

    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 3 }));
    const rows = (await getJobLotConsumption(ownerA, jobId)) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].lotId).toBe(good.id);

    await expect(
      issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 1, lotAllocations: [{ lotId: expired.id, quantity: 1 }] })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 1, lotAllocations: [{ lotId: quarantined.id, quantity: 1 }] })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("insufficient LOT-AVAILABLE stock blocks the whole issue atomically, even when the warehouse's physical balance is sufficient", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    await receiveLot(itemId, 10, 5); // active
    const quarantined = await receiveLot(itemId, 10, 5);
    await setLotStatus(inv, quarantined.id, { status: "quarantined", reason: "supplier recall" });
    const jobId = await job(pid);

    const physicalBefore = ((await listStockBalances(ownerA, { itemId, warehouseId: wh1 })) as any[])[0];
    expect(String(physicalBefore.quantity)).toBe("20"); // both lots count toward physical stock

    await expect(issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 15 }))).rejects.toBeInstanceOf(ValidationError);

    const physicalAfter = ((await listStockBalances(ownerA, { itemId, warehouseId: wh1 })) as any[])[0];
    expect(String(physicalAfter.quantity)).toBe("20"); // rolled back -- nothing posted
    expect(((await getJob(ownerA, jobId)) as any).status).toBe("released"); // job not started
  });

  it("one lot can supply multiple different jobs; remaining reflects the combined draw", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 5);
    const job1 = await job(pid);
    const job2 = await job(pid);
    await issueMaterialToJob(ownerA, job1, issuePayload(itemId, { quantity: 4 }));
    await issueMaterialToJob(ownerA, job2, issuePayload(itemId, { quantity: 3 }));

    const detail = await getLotDetail(ownerA, lot.id);
    expect(String(detail.remaining)).toBe("3");
    const rows1 = (await getJobLotConsumption(ownerA, job1)) as any[];
    const rows2 = (await getJobLotConsumption(ownerA, job2)) as any[];
    expect(String(rows1.find((r) => r.lotId === lot.id).consumed)).toBe("4");
    expect(String(rows2.find((r) => r.lotId === lot.id).consumed)).toBe("3");
  });

  it("concurrent issues against the SAME lot that together exactly exhaust it both succeed with no lost update", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 5);
    const jobA = await job(pid);
    const jobB = await job(pid);
    await Promise.all([
      issueMaterialToJob(ownerA, jobA, issuePayload(itemId, { quantity: 6 })),
      issueMaterialToJob(ownerA, jobB, issuePayload(itemId, { quantity: 4 })),
    ]);
    const detail = await getLotDetail(ownerA, lot.id);
    expect(String(detail.remaining)).toBe("0");
    const rowsA = (await getJobLotConsumption(ownerA, jobA)) as any[];
    const rowsB = (await getJobLotConsumption(ownerA, jobB)) as any[];
    expect(String(rowsA.find((r) => r.lotId === lot.id).consumed)).toBe("6");
    expect(String(rowsB.find((r) => r.lotId === lot.id).consumed)).toBe("4");
  });

  it("concurrent over-committing issues against lot-AVAILABLE stock: exactly one succeeds, even though physical stock alone would allow both", async () => {
    // Physical stock = 12kg (sufficient for both 6kg requests), but only 6kg of it
    // is lot-AVAILABLE (the other 6kg lot is quarantined) -- isolates the race to
    // the lot-allocation layer specifically, rather than the generic stock-balance
    // guard (which 6+6=12 against exactly 12kg physical would never trip either way).
    const { productId: pid, itemId } = await freshLotMaterial();
    const available = await receiveLot(itemId, 6, 5);
    const quarantined = await receiveLot(itemId, 6, 5);
    await setLotStatus(inv, quarantined.id, { status: "quarantined", reason: "supplier recall" });
    const jobA = await job(pid);
    const jobB = await job(pid);
    const results = await Promise.allSettled([
      issueMaterialToJob(ownerA, jobA, issuePayload(itemId, { quantity: 6 })),
      issueMaterialToJob(ownerA, jobB, issuePayload(itemId, { quantity: 6 })),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
    const detail = await getLotDetail(ownerA, available.id);
    expect(String(detail.remaining)).toBe("0"); // exactly the one successful draw, never negative or double-allocated
  });

  it("is idempotent: a replay never writes a second LotConsumption batch", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    await receiveLot(itemId, 10, 5);
    const jobId = await job(pid);
    const p = issuePayload(itemId, { quantity: 4 });
    const first = await issueMaterialToJob(ownerA, jobId, p);
    const second = await issueMaterialToJob(ownerA, jobId, p);
    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    // toMovementView() deliberately returns Record<string, unknown> (its shape
    // depends on the caller's capabilities -- see stock-core.ts), so `.id` is
    // `unknown` to the type checker even though it's always a string at
    // runtime (toMovementView always sets it from the movement row's own id).
    const count = await prisma.lotConsumption.count({ where: { orgId: orgA.organizationId, movementId: first.movement.id as string } });
    expect(count).toBe(1);
  });
});

describe("returns: good disposition", () => {
  it("credits back to the original lot at a WEIGHTED (not simple-averaged) per-lot cost basis across two differently-costed consumption events", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 4); // avg becomes 4
    const jobId = await job(pid);

    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 6 })); // consumes 6 @ 4 from `lot`
    await receiveLot(itemId, 10, 11); // new avg = (4*4 + 10*11) / 14 = 9 exactly
    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 2 })); // consumes 2 more @ 9, still from `lot` (received earliest)

    // weighted avg over lot's own consumption: (6*4 + 2*9) / 8 = 5.25 -- NOT the simple mean of {4,9} (6.5)
    // and NOT the current pool average (9).
    const ret = await returnMaterialFromJob(
      ownerA,
      jobId,
      returnPayload(itemId, { quantity: 5, reason: "QA hold lifted", lotReturns: [{ lotId: lot.id, quantity: 5, disposition: "good" }] }),
    );
    expect(ret.replayed).toBe(false);
    expect(String(ret.movement.unitCost)).toBe("5.25");
    expect(ret.movement.currency).toBe("USD");

    const detail = await getLotDetail(ownerA, lot.id);
    expect(String(detail.remaining)).toBe("7"); // 10 - 8 consumed + 5 returned
    expect(detail.available).toBe(true); // available for reissue again

    const reissued = await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 1, lotAllocations: [{ lotId: lot.id, quantity: 1 }] }));
    expect(reissued.replayed).toBe(false);
  });

  it("cannot return more than a job's outstanding balance from a specific lot", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 5);
    const jobId = await job(pid);
    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 3 }));
    await expect(
      returnMaterialFromJob(ownerA, jobId, returnPayload(itemId, { quantity: 4, reason: "test", lotReturns: [{ lotId: lot.id, quantity: 4 }] })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("lotReturns is required when the job's consumption was lot-tracked, and forbidden when it wasn't", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    await receiveLot(itemId, 10, 5);
    const trackedJob = await job(pid);
    await issueMaterialToJob(ownerA, trackedJob, issuePayload(itemId, { quantity: 2 }));
    await expect(
      returnMaterialFromJob(ownerA, trackedJob, returnPayload(itemId, { quantity: 1, reason: "test" })),
    ).rejects.toBeInstanceOf(ValidationError);

    const untrackedJob = await job(plainProductId);
    await issueMaterialToJob(ownerA, untrackedJob, issuePayload(plainMaterialId, { quantity: 2 }));
    await expect(
      returnMaterialFromJob(
        ownerA,
        untrackedJob,
        returnPayload(plainMaterialId, { quantity: 1, reason: "test", lotReturns: [{ lotId: randomUUID(), quantity: 1 }] }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("lotReturns quantities must sum exactly to the returned quantity, and no lot may repeat", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lotX = await receiveLot(itemId, 10, 5);
    const lotY = await receiveLot(itemId, 10, 5);
    const jobId = await job(pid);
    await issueMaterialToJob(
      ownerA,
      jobId,
      issuePayload(itemId, { quantity: 6, lotAllocations: [{ lotId: lotX.id, quantity: 3 }, { lotId: lotY.id, quantity: 3 }] }),
    );

    await expect(
      returnMaterialFromJob(ownerA, jobId, returnPayload(itemId, { quantity: 2, reason: "test", lotReturns: [{ lotId: lotX.id, quantity: 1 }] })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      returnMaterialFromJob(
        ownerA,
        jobId,
        returnPayload(itemId, {
          quantity: 2,
          reason: "test",
          lotReturns: [{ lotId: lotX.id, quantity: 1 }, { lotId: lotX.id, quantity: 1 }],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("returns: quarantine disposition", () => {
  it("spawns a new traceable lot; the original lot's balance is unaffected until the child is released", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 6, { supplierLotRef: "SUP-REF-1" });
    const jobId = await job(pid);
    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 7 }));

    const before = await getLotDetail(ownerA, lot.id);
    expect(String(before.remaining)).toBe("3");

    const ret = await returnMaterialFromJob(
      ownerA,
      jobId,
      returnPayload(itemId, { quantity: 4, reason: "failed incoming QA re-check", lotReturns: [{ lotId: lot.id, quantity: 4, disposition: "quarantine" }] }),
    );
    expect(ret.replayed).toBe(false);

    const afterOriginal = await getLotDetail(ownerA, lot.id);
    expect(String(afterOriginal.remaining)).toBe("3"); // untouched: no return LotConsumption written against it
    expect(afterOriginal.returnChildLots).toHaveLength(1);

    const childId = afterOriginal.returnChildLots[0].id;
    const child = await getLotDetail(ownerA, childId);
    expect(child.status).toBe("quarantined");
    expect(String(child.quantityReceived)).toBe("4");
    expect(String(child.remaining)).toBe("4");
    expect(child.available).toBe(false);
    expect(child.origin.type).toBe("return");
    expect((child.origin as any).sourceReturnOfLotId).toBe(lot.id);
    expect((child.origin as any).sourceReturnJobId).toBe(jobId);

    // The quarantined child cannot be drawn from, by explicit override --
    await expect(
      issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 1, lotAllocations: [{ lotId: childId, quantity: 1 }] })),
    ).rejects.toBeInstanceOf(ValidationError);

    // -- but once released, it becomes consumable again.
    await setLotStatus(inv, childId, { status: "active", reason: "re-inspected and passed" });
    const released = await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 1, lotAllocations: [{ lotId: childId, quantity: 1 }] }));
    expect(released.replayed).toBe(false);
    const childAfter = await getLotDetail(ownerA, childId);
    expect(String(childAfter.remaining)).toBe("3");

    // Full traceability chain walks from the child back to the original receipt.
    const trace = await getLotTraceability(ownerA, childId);
    expect(trace.originChain.some((h: any) => h.type === "return" && h.lotId === childId)).toBe(true);
    expect(trace.originChain.some((h: any) => h.type === "receipt" && h.lotId === lot.id)).toBe(true);
  });
});

describe("backward compatibility: items never lot-tracked in a warehouse", () => {
  it("issuing and returning plain (never-lotted) material is completely unaffected by the lot machinery", async () => {
    const jobId = await job(plainProductId);
    const res = await issueMaterialToJob(ownerA, jobId, issuePayload(plainMaterialId, { quantity: 5 }));
    expect(res.replayed).toBe(false);
    expect(await getJobLotConsumption(ownerA, jobId)).toEqual([]);
    const ret = await returnMaterialFromJob(ownerA, jobId, returnPayload(plainMaterialId, { quantity: 2, reason: "unused" }));
    expect(ret.replayed).toBe(false);
    const mats = (await getJobMaterials(ownerA, jobId)) as any[];
    expect(String(mats.find((r) => r.materialItemId === plainMaterialId).issuedQty)).toBe("3"); // net of the return
  });
});

describe("lot-service: capability matrix, read endpoints, and isolation", () => {
  it("lot:read is required for browsing/detail/traceability; PRODUCTION_OPERATOR (material:issue only) is refused", async () => {
    const { itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 5);
    for (const s of [ownerA, opsMgr, prodMgr, inv, viewer, finance]) {
      await expect(getAvailableLotsForIssue(s, { itemId, warehouseId: wh1 })).resolves.toBeTruthy();
      await expect(listLots(s, { itemId })).resolves.toBeTruthy();
      await expect(getLotDetail(s, lot.id)).resolves.toBeTruthy();
      await expect(getLotTraceability(s, lot.id)).resolves.toBeTruthy();
    }
    for (const s of [operator]) {
      await expect(getAvailableLotsForIssue(s, { itemId, warehouseId: wh1 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listLots(s, { itemId })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getLotDetail(s, lot.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getLotTraceability(s, lot.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("lot:manage is required for setLotStatus; only owner/operations/inventory managers hold it", async () => {
    const { itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 5);
    for (const s of [prodMgr, viewer, finance, operator]) {
      await expect(setLotStatus(s, lot.id, { status: "quarantined", reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const quarantined = await setLotStatus(inv, lot.id, { status: "quarantined", reason: "supplier recall" });
    expect(quarantined.status).toBe("quarantined");
    const active = await setLotStatus(opsMgr, lot.id, { status: "active", reason: "recall cleared" });
    expect(active.status).toBe("active");
  });

  it("an expired lot's status can never be changed, and repeating the current status is rejected", async () => {
    const { itemId } = await freshLotMaterial();
    const expired = await receiveLot(itemId, 10, 5, { expiryDate: isoDate(-1) });
    await expect(setLotStatus(inv, expired.id, { status: "quarantined", reason: "x" })).rejects.toBeInstanceOf(ConflictError);
    const stillActive = await receiveLot(itemId, 10, 5); // a second, non-expired lot of the same item
    await expect(setLotStatus(inv, stillActive.id, { status: "active", reason: "already active" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("an operator can issue/return lot-tracked material via auto-allocation without holding lot:read", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    await receiveLot(itemId, 10, 5);
    const jobId = await job(pid);
    const res = await issueMaterialToJob(operator, jobId, issuePayload(itemId, { quantity: 3 }));
    expect(res.replayed).toBe(false);
    const rows = (await getJobLotConsumption(operator, jobId)) as any[]; // production_job:read, not lot:read
    expect(rows).toHaveLength(1);
    const ret = await returnMaterialFromJob(
      operator,
      jobId,
      returnPayload(itemId, { quantity: 1, reason: "qa", lotReturns: [{ lotId: rows[0].lotId, quantity: 1, disposition: "good" }] }),
    );
    expect(ret.replayed).toBe(false);
  });

  it("getJobLotConsumption is a no-op ([]) for a job that only consumed non-lot-tracked material", async () => {
    const jobId = await job(plainProductId);
    await issueMaterialToJob(ownerA, jobId, issuePayload(plainMaterialId, { quantity: 2 }));
    expect(await getJobLotConsumption(ownerA, jobId)).toEqual([]);
  });

  it("listLots filters by item, warehouse and status", async () => {
    const { itemId } = await freshLotMaterial();
    const active = await receiveLot(itemId, 10, 5);
    const toQuarantine = await receiveLot(itemId, 10, 5);
    await setLotStatus(inv, toQuarantine.id, { status: "quarantined", reason: "x" });

    const all = (await listLots(ownerA, { itemId })) as any[];
    expect(all.map((l) => l.id).sort()).toEqual([active.id, toQuarantine.id].sort());
    const onlyActive = (await listLots(ownerA, { itemId, status: "active" })) as any[];
    expect(onlyActive.map((l) => l.id)).toEqual([active.id]);
    const bySearch = (await listLots(ownerA, { search: active.lotNumber })) as any[];
    expect(bySearch.some((l) => l.id === active.id)).toBe(true);
  });

  it("org and branch isolation: a lot/job in org A branch 1 is invisible to org B and to branch 2", async () => {
    const { productId: pid, itemId } = await freshLotMaterial();
    const lot = await receiveLot(itemId, 10, 5);
    const jobId = await job(pid);
    await issueMaterialToJob(ownerA, jobId, issuePayload(itemId, { quantity: 1 }));

    for (const s of [ownerB, prodMgr2]) {
      await expect(getLotDetail(s, lot.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getLotTraceability(s, lot.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getJobLotConsumption(s, jobId)).rejects.toBeInstanceOf(NotFoundError);
    }
    for (const s of [ownerB, opsMgr2]) {
      await expect(setLotStatus(s, lot.id, { status: "quarantined", reason: "x" })).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(issueMaterialToJob(ownerB, jobId, issuePayload(itemId, { quantity: 1 }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      issueMaterialToJob(prodMgr2, jobId, issuePayload(itemId, { quantity: 1, warehouseId: wh2 })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reconciliation invariants", () => {
  it("INVARIANT: every lot-tracked movement's LotConsumption rows sum to that movement's own quantity, and no lot's remaining ever goes negative", async () => {
    for (const org of [orgA, orgB]) {
      const mismatches = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT sm.id
        FROM stock_movement sm
        JOIN (SELECT movement_id, SUM(quantity) AS sum_qty FROM lot_consumption GROUP BY movement_id) lc
          ON lc.movement_id = sm.id
        WHERE sm.org_id = ${org.organizationId}::uuid
          AND sm.movement_type IN ('production_consumption', 'material_return')
          AND abs(lc.sum_qty) <> abs(sm.quantity)
      `;
      expect(mismatches).toEqual([]);

      const negative = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT ml.id
        FROM material_lot ml LEFT JOIN lot_consumption lc ON lc.lot_id = ml.id
        WHERE ml.org_id = ${org.organizationId}::uuid
        GROUP BY ml.id, ml.quantity_received
        HAVING ml.quantity_received - COALESCE(SUM(lc.quantity), 0) < 0
      `;
      expect(negative).toEqual([]);
    }
    const consumptionRows = await prisma.lotConsumption.count({ where: { orgId: orgA.organizationId } });
    expect(consumptionRows).toBeGreaterThan(5);
  });
});
