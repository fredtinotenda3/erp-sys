// Milestone 6 (Plastics Manufacturing Vertical): regrind generation and its
// read-side lineage in lot-service.ts. Real-database test, not executed in
// this environment -- see IMPLEMENTATION_MANIFEST.md and
// industry-profile-service.test.ts's header comment for why. Run with
// `npm test -- regrind-service`.
//
// Covers:
//  - createRegrindLot: posts a regrind_generation movement (never
//    purchase_receipt -- mandate's explicit "do not count regrind as newly
//    purchased raw material"), spawns a new MaterialLot of the SAME item
//    with no supplier, raises the warehouse balance by exactly the regrind
//    quantity
//  - itemType gate (raw_material/consumable only), inactive-item rejection,
//    warehouse must be active and in the source job's own branch
//  - clientRequestId idempotency: replay returns the original movement,
//    reuse with different data is a ConflictError (same discipline as
//    every other stock-posting service)
//  - regrind:create capability and the plastics-profile write gate
//  - lot-service.ts's "regrind" origin branch on getLotDetail and
//    getLotTraceability -- job-level traceability, not a single parent
//    lot, and regrind is a chain TERMINUS (same as a receipt)
//  - org/branch isolation
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { sessionWithRole, productWithActiveBom } from "../../production/__tests__/production-helpers";
import { createItem, updateItem } from "../../catalog/item-service";
import { createWarehouse } from "../warehouse-service";
import { createJob } from "../../production/job-service";
import { updateIndustryProfile } from "../../industry/industry-profile-service";
import { createRegrindLot } from "../regrind-service";
import { getLotDetail, getLotTraceability } from "../lot-service";
import { prisma } from "../../../shared/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let org: TestOrg;
let owner: AuthenticatedSession;
let inv: AuthenticatedSession; // regrind:create
let prodMgr: AuthenticatedSession; // lacks regrind:create (mirrors lot:manage's role set, which PRODUCTION_MANAGER lacks)
let operator: AuthenticatedSession; // lacks regrind:create and lot:read
let wh: string;
let resinItemId: string;
let jobId: string;
let jobBranchId: string;

let skuCounter = 0;
function sku(prefix: string) {
  skuCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${skuCounter}`;
}

beforeAll(async () => {
  org = await createTestOrg("regrindA");
  owner = await ownerSession(org);
  inv = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "rg-inv", [org.branchId]);
  prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "rg-pm", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "rg-op", [org.branchId]);
  await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });

  jobBranchId = org.branchId;
  wh = (await createWarehouse(owner, { branchId: jobBranchId, name: "Regrind store" })).id;
  resinItemId = (await createItem(owner, { sku: sku("RESIN"), itemType: "raw_material", name: "Regrind test resin", uom: "kg" })).id;

  const { product } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }]);
  // createJob/getJob return an untyped Record<string, unknown> view (see
  // job-view.ts's toJobView) -- same `as any` idiom every other test file
  // in this project uses at this exact call site.
  jobId = ((await createJob(owner, { branchId: jobBranchId, productItemId: product.id, plannedQty: 10 })) as any).id;
}, 180_000);

function payload(extra: Record<string, unknown> = {}) {
  return {
    clientRequestId: randomUUID(),
    sourceJobId: jobId,
    itemId: resinItemId,
    warehouseId: wh,
    quantity: 5,
    unitCost: 0.8,
    currency: "USD",
    ...extra,
  };
}

describe("createRegrindLot", () => {
  it("posts a regrind_generation movement and raises the warehouse balance", async () => {
    const r: any = await createRegrindLot(inv, payload({ notes: "Ground from job scrap, batch 1" }));
    expect(r.replayed).toBe(false);
    expect(r.movement.movementType).toBe("regrind_generation");
    expect(r.movement.referenceType).toBe("production_job");
    expect(r.movement.referenceId).toBe(jobId);
    expect(r.balance.quantity.toString()).toBe("5");
  });

  it("accumulates the balance across multiple regrind postings to the same item/warehouse", async () => {
    // The previous test posted quantity 5 to this same item/warehouse; this
    // one adds 3 more and expects the running balance to reflect both --
    // confirming regrind stock behaves as ordinary, summable warehouse
    // stock, not a side ledger. (Whether the spawned lot itself has the
    // right shape -- same item, no supplier, job-level traceability -- is
    // verified via lot-service.ts's read path in the next describe block,
    // which is the real contract other code and the UI rely on; this
    // service's own return value never hands back the lot id.)
    const r: any = await createRegrindLot(inv, payload({ quantity: 3 }));
    expect(r.balance.quantity.toString()).toBe("8");
  });

  it("is idempotent: a replayed clientRequestId returns the original movement, not a second one", async () => {
    const p = payload();
    const first: any = await createRegrindLot(inv, p);
    const second: any = await createRegrindLot(inv, p);
    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
  });

  it("rejects reusing a clientRequestId with different data", async () => {
    const clientRequestId = randomUUID();
    await createRegrindLot(inv, payload({ clientRequestId, quantity: 2 }));
    await expect(createRegrindLot(inv, payload({ clientRequestId, quantity: 4 }))).rejects.toThrow(ConflictError);
  });

  it("rejects a finished_good item -- regrind can only be generated for raw_material or consumable", async () => {
    const { product } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }]);
    await expect(createRegrindLot(inv, payload({ itemId: product.id }))).rejects.toThrow(ValidationError);
  });

  it("rejects an inactive item", async () => {
    const item = await createItem(owner, { sku: sku("INACTIVE"), itemType: "raw_material", name: "Inactive resin", uom: "kg" });
    await updateItem(owner, item.id, { isActive: false });
    await expect(createRegrindLot(inv, payload({ itemId: item.id }))).rejects.toThrow(ValidationError);
  });

  it("rejects an inactive warehouse", async () => {
    const otherWh = await createWarehouse(owner, { branchId: jobBranchId, name: "To be deactivated" });
    // warehouse-service.ts has no update function in this codebase -- same
    // direct-DB-write convention dispatch-service.test.ts already uses for
    // this exact precondition.
    await prisma.warehouse.update({ where: { id: otherWh.id }, data: { isActive: false } });
    await expect(createRegrindLot(inv, payload({ warehouseId: otherWh.id }))).rejects.toThrow(ValidationError);
  });

  it("rejects a warehouse in a different branch than the source job", async () => {
    const branch2 = await createBranch(owner, { name: "Regrind branch 2" });
    const wh2 = await createWarehouse(owner, { branchId: branch2.id, name: "Branch 2 store" });
    // OWNER_ADMIN specifically, so this isolates the branch-mismatch
    // ValidationError from an incidental branch-access NotFoundError --
    // `inv`'s session only has access to the main branch, so using it here
    // would fail for the wrong reason (same technique as
    // milestone4-extensions.test.ts's work-centre/machine branch-mismatch test).
    await expect(createRegrindLot(owner, payload({ warehouseId: wh2.id }))).rejects.toThrow(ValidationError);
  });

  it("rejects an unknown currency code", async () => {
    await expect(createRegrindLot(inv, payload({ currency: "ZZZ" }))).rejects.toThrow(ValidationError);
  });

  it("rejects a non-positive quantity or unitCost", async () => {
    await expect(createRegrindLot(inv, payload({ quantity: 0 }))).rejects.toThrow(ValidationError);
    await expect(createRegrindLot(inv, payload({ unitCost: -1 }))).rejects.toThrow(ValidationError);
  });

  it("404s for a source job that does not belong to this organization or is out of branch scope", async () => {
    await expect(createRegrindLot(inv, payload({ sourceJobId: randomUUID() }))).rejects.toThrow(NotFoundError);
  });

  it("requires regrind:create -- PRODUCTION_MANAGER and PRODUCTION_OPERATOR both lack it (mirrors lot:manage's role set)", async () => {
    await expect(createRegrindLot(prodMgr, payload())).rejects.toThrow(ForbiddenError);
    await expect(createRegrindLot(operator, payload())).rejects.toThrow(ForbiddenError);
  });

  it("requires the plastics profile to be active", async () => {
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
    await expect(createRegrindLot(inv, payload())).rejects.toThrow(ValidationError);
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  });
});

describe("lot-service.ts: regrind lineage (getLotDetail / getLotTraceability)", () => {
  it("getLotDetail reports a regrind lot's origin as job-level, not a single parent lot", async () => {
    await createRegrindLot(inv, payload({ quantity: 7 }));
    // createRegrindLot's own return value doesn't include the spawned
    // lot's id (see shape() -- it returns {replayed, movement, balance}),
    // so resolve it directly here (test-only -- not a service function),
    // the same way lot-consumption.test.ts resolves receipt-spawned lot
    // ids where no service call hands one back.
    const lot = await prisma.materialLot.findFirst({
      where: { orgId: org.organizationId, itemId: resinItemId, sourceRegrindJobId: jobId, quantityReceived: "7" },
      orderBy: { createdAt: "desc" },
    });
    expect(lot).toBeTruthy();

    const detail: any = await getLotDetail(inv, lot!.id);
    expect(detail.origin.type).toBe("regrind");
    expect(detail.origin.sourceRegrindJobId).toBe(jobId);
    expect(detail.supplierId).toBeNull();

    const trace: any = await getLotTraceability(inv, lot!.id);
    expect(trace.originChain).toHaveLength(1);
    expect(trace.originChain[0].type).toBe("regrind");
    expect(trace.originChain[0].generatedFromJobId).toBe(jobId);
  });
});

describe("tenant isolation", () => {
  it("a job, item, or warehouse from a different organization never resolves", async () => {
    const orgB = await createTestOrg("regrindB");
    const ownerB = await ownerSession(orgB);
    // Switched to plastics first so this request fails on the tenant-
    // isolation check this test actually targets, not on the (separately
    // tested, above) profile gate.
    await updateIndustryProfile(ownerB, { industryProfile: "plastics", enabledModules: [] });
    await expect(
      createRegrindLot(ownerB, payload({ sourceJobId: jobId, itemId: resinItemId, warehouseId: wh })),
    ).rejects.toThrow(NotFoundError);
  });
});
