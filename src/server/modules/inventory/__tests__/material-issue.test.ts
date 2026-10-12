/* eslint-disable @typescript-eslint/no-explicit-any -- views are intentionally loose Record<string, unknown> projections */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { listAuditLog } from "../../iam/audit-service";
import { prisma } from "../../../shared/db";
import { createJob, getJob, transitionJob, completeJob } from "../../production/job-service";
import { createWarehouse } from "../warehouse-service";
import { receiveStock, listStockBalances, listStockMovements } from "../stock-service";
import { issueMaterialToJob, getJobMaterials } from "../material-issue-service";
import { findBalanceMismatches } from "../reconciliation";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let prodMgr: AuthenticatedSession;
let prodMgr2: AuthenticatedSession; // branch 2 only
let operator: AuthenticatedSession;
let viewer: AuthenticatedSession;
let finance: AuthenticatedSession;
let inv: AuthenticatedSession;
let wh1: string;
let wh2: string;
let productId: string;
let m1: string; // 2 per unit, kg: stocked 500 @ 2 USD + 500 @ 4 USD => 1000 kg at avg 3
let m2: string; // 1 per unit, ea: stocked 100 @ 10 ZIG

beforeAll(async () => {
  orgA = await createTestOrg("issA");
  orgB = await createTestOrg("issB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  wh1 = (await createWarehouse(ownerA, { branchId: orgA.branchId, name: "Main store" })).id;
  wh2 = (await createWarehouse(ownerA, { branchId: branch2, name: "Second store" })).id;
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
  prodMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm2", [branch2]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "vw", [orgA.branchId]);
  finance = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fm", [orgA.branchId]);
  inv = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "inv", [orgA.branchId]);

  const p = await productWithActiveBom(ownerA, [
    { uom: "kg", standardCost: 3, standardCostCurrency: "USD", bomQty: 2 },
    { uom: "ea", standardCost: 10, standardCostCurrency: "ZIG", bomQty: 1 },
  ]);
  productId = p.product.id;
  m1 = p.materialItems[0].id;
  m2 = p.materialItems[1].id;

  const rec = (itemId: string, quantity: number, unitCost: number, currency: string) =>
    receiveStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId, quantity, unitCost, currency });
  await rec(m1, 500, 2, "USD");
  await rec(m1, 500, 4, "USD");
  await rec(m2, 100, 10, "ZIG");
}, 240_000);

async function job(status: "planned" | "released" = "released", plannedQty = 10): Promise<string> {
  const j = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: productId, plannedQty })) as Record<string, any>;
  if (status === "released") await transitionJob(ownerA, j.id, { status: "released" });
  return j.id;
}
const issue = (over: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  materialItemId: m1,
  warehouseId: wh1,
  quantity: 5,
  ...over,
});
const balanceOf = async (itemId: string) => Number(((await listStockBalances(ownerA, { itemId, warehouseId: wh1 })) as any[])[0].quantity);

describe("issueMaterialToJob", () => {
  it("posts a negative production_consumption at weighted-average cost and starts the job", async () => {
    const id = await job();
    const before = await balanceOf(m1);
    const res = await issueMaterialToJob(ownerA, id, issue({ quantity: 5 }));

    expect(res.replayed).toBe(false);
    expect(res.movement.movementType).toBe("production_consumption");
    expect(String(res.movement.quantity)).toBe("-5");
    expect(res.movement.referenceId).toBe(id);
    expect(String(res.movement.unitCost)).toBe("3"); // stamped by the ledger from the average, not supplied
    expect(res.movement.currency).toBe("USD");
    expect(await balanceOf(m1)).toBe(before - 5);

    const j = (await getJob(ownerA, id)) as Record<string, any>;
    expect(j.status).toBe("in_progress");
    expect(j.actualStart).toBeTruthy();
    const entries = (await listAuditLog(ownerA, { entityType: "production_job", entityId: id })) as any[];
    expect(entries.some((e) => e.reason === "first material issue")).toBe(true);
  });

  it("is idempotent: a replay deducts stock once, and works even after the job completed", async () => {
    const id = await job();
    const p = issue({ quantity: 4 });
    const before = await balanceOf(m1);
    const first = await issueMaterialToJob(ownerA, id, p);
    const second = await issueMaterialToJob(ownerA, id, p);
    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    expect(await balanceOf(m1)).toBe(before - 4);

    await completeJob(prodMgr, id);
    const afterComplete = await issueMaterialToJob(ownerA, id, p);
    expect(afterComplete.replayed).toBe(true);
    await expect(issueMaterialToJob(ownerA, id, { ...p, quantity: 9 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("concurrent identical submissions deduct once", async () => {
    const id = await job();
    const p = issue({ quantity: 3 });
    const before = await balanceOf(m1);
    const results = await Promise.all([issueMaterialToJob(ownerA, id, p), issueMaterialToJob(ownerA, id, p), issueMaterialToJob(ownerA, id, p)]);
    expect(new Set(results.map((r) => r.movement.id)).size).toBe(1);
    expect(await balanceOf(m1)).toBe(before - 3);
  });

  it("concurrent DIFFERENT issues all post and total correctly", async () => {
    const id = await job();
    const before = await balanceOf(m1);
    await Promise.all([1, 2, 3, 4].map((q) => issueMaterialToJob(ownerA, id, issue({ quantity: q }))));
    expect(await balanceOf(m1)).toBe(before - 10);
  });

  it("over-issuing against the BOM is allowed and shown as a variance, not blocked", async () => {
    const id = await job("released", 1); // expects 2 kg of m1
    await issueMaterialToJob(ownerA, id, issue({ quantity: 5 }));
    const mats = (await getJobMaterials(ownerA, id)) as any[];
    const row = mats.find((r) => r.materialItemId === m1);
    expect(String(row.expectedQty)).toBe("2");
    expect(String(row.issuedQty)).toBe("5");
    expect(String(row.remainingQty)).toBe("0");
    expect(String(row.overIssuedQty)).toBe("3");
    const other = mats.find((r) => r.materialItemId === m2);
    expect(String(other.issuedQty)).toBe("0");
  });

  it("refused for insufficient stock: nothing posted and the job is NOT started", async () => {
    const id = await job();
    const before = await balanceOf(m1);
    await expect(issueMaterialToJob(ownerA, id, issue({ quantity: 5000 }))).rejects.toBeInstanceOf(ConflictError);
    expect(await balanceOf(m1)).toBe(before);
    expect(((await getJob(ownerA, id)) as any).status).toBe("released"); // atomic: the status change rolled back too
    expect(((await listStockMovements(ownerA, { referenceId: id })) as any[])).toHaveLength(0);
  });

  it("refused when the material was never received into any warehouse", async () => {
    const p = await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }]);
    const j = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: p.product.id, plannedQty: 1 })) as Record<string, any>;
    await transitionJob(ownerA, j.id, { status: "released" });
    await expect(
      issueMaterialToJob(ownerA, j.id, issue({ materialItemId: p.materialItems[0].id, quantity: 1 })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(((await getJob(ownerA, j.id)) as any).status).toBe("released");
  });

  it("only released or in-progress jobs accept material", async () => {
    const planned = await job("planned");
    await expect(issueMaterialToJob(ownerA, planned, issue())).rejects.toBeInstanceOf(ConflictError);
    const held = await job();
    await transitionJob(prodMgr, held, { status: "on_hold", reason: "test" });
    await expect(issueMaterialToJob(ownerA, held, issue())).rejects.toBeInstanceOf(ConflictError);
    const done = await job();
    await issueMaterialToJob(ownerA, done, issue({ quantity: 1 }));
    await completeJob(prodMgr, done);
    await expect(issueMaterialToJob(ownerA, done, issue())).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects a material that is not in the job's BOM snapshot", async () => {
    const id = await job();
    const stranger = await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }]);
    await expect(
      issueMaterialToJob(ownerA, id, issue({ materialItemId: stranger.materialItems[0].id })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a warehouse from a different branch than the job", async () => {
    const id = await job();
    await expect(issueMaterialToJob(ownerA, id, issue({ warehouseId: wh2 }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates the payload", async () => {
    const id = await job();
    for (const bad of [issue({ quantity: 0 }), issue({ quantity: -1 }), issue({ quantity: 1.00001 }), issue({ clientRequestId: "x" }), issue({ materialItemId: "x" })]) {
      await expect(issueMaterialToJob(ownerA, id, bad)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("capabilities: operator, production and inventory managers may issue; viewer and finance may not", async () => {
    const id = await job();
    for (const s of [operator, prodMgr, inv]) {
      await expect(issueMaterialToJob(s, id, issue({ quantity: 1 }))).resolves.toBeTruthy();
    }
    for (const s of [viewer, finance]) {
      await expect(issueMaterialToJob(s, id, issue({ quantity: 1 }))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("an operator's response carries no cost and no stock balance", async () => {
    const id = await job();
    const res = await issueMaterialToJob(operator, id, issue({ quantity: 1 }));
    expect("unitCost" in res.movement).toBe(false);
    expect("currency" in res.movement).toBe(false);
    expect(res.balance).toBeUndefined();
    const mats = (await getJobMaterials(operator, id)) as any[];
    expect("standardUnitCost" in mats[0]).toBe(false);
  });

  it("branch and tenant isolation", async () => {
    const id = await job();
    await expect(issueMaterialToJob(prodMgr2, id, issue({ warehouseId: wh2 }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(issueMaterialToJob(ownerB, id, issue())).rejects.toBeInstanceOf(NotFoundError);
    await expect(getJobMaterials(ownerB, id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getJobMaterials(prodMgr2, id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("job materials: viewer may read expected vs issued", async () => {
    const id = await job();
    await issueMaterialToJob(ownerA, id, issue({ quantity: 6 }));
    const mats = (await getJobMaterials(viewer, id)) as any[];
    expect(String(mats.find((r) => r.materialItemId === m1).issuedQty)).toBe("6");
  });

  it("INVARIANT: balances equal ledger sums after all the issues above", async () => {
    expect(await findBalanceMismatches(orgA.organizationId)).toEqual([]);
    expect(await findBalanceMismatches(orgB.organizationId)).toEqual([]);
    // Sanity: the ledger really did record consumption against jobs.
    const consumption = await prisma.stockMovement.count({ where: { orgId: orgA.organizationId, movementType: "production_consumption" } });
    expect(consumption).toBeGreaterThan(10);
  });
});
