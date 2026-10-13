/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { createItem, updateItem } from "../../catalog/item-service";
import { createJob, transitionJob } from "../../production/job-service";
import { createWarehouse } from "../warehouse-service";
import { receiveStock } from "../stock-service";
import { issueMaterialToJob } from "../material-issue-service";
import { getShortages } from "../shortage-service";
import { ForbiddenError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let viewer: AuthenticatedSession;
let operator: AuthenticatedSession;
let inv2: AuthenticatedSession;
let branch2: string;
let wh1: string;
let p: Awaited<ReturnType<typeof productWithActiveBom>>;
let m1: string; // 2 per unit
let m2: string; // 1 per unit, never received
let jobA: string; // 10 units, released  => needs 20 m1, 10 m2
let jobB: string; // 5 units, planned    => needs 10 m1, 5 m2

const rec = (itemId: string, quantity: number) =>
  receiveStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId, quantity, unitCost: 1, currency: "USD" });
const row = async (itemId: string, over: Record<string, unknown> = {}) =>
  ((await getShortages(ownerA, over)) as any[]).find((r) => r.item.id === itemId);

beforeAll(async () => {
  orgA = await createTestOrg("shA");
  orgB = await createTestOrg("shB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  wh1 = (await createWarehouse(ownerA, { branchId: orgA.branchId, name: "Main store" })).id;
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "vw", [orgA.branchId]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  inv2 = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "inv2", [branch2]);

  p = await productWithActiveBom(ownerA, [
    { uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 2 },
    { uom: "ea", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 },
  ]);
  m1 = p.materialItems[0].id;
  m2 = p.materialItems[1].id;
  jobA = ((await createJob(ownerA, { branchId: orgA.branchId, productItemId: p.product.id, plannedQty: 10 })) as any).id;
  await transitionJob(ownerA, jobA, { status: "released" });
  jobB = ((await createJob(ownerA, { branchId: orgA.branchId, productItemId: p.product.id, plannedQty: 5 })) as any).id;
  await rec(m1, 25);
}, 240_000);

describe("shortages", () => {
  it("reports a shortage per item with the jobs that drive it", async () => {
    const r = await row(m1);
    expect(r.status).toBe("shortage");
    expect(r.onHand).toBe("25");
    expect(r.remainingRequirement).toBe("30"); // 20 (job A) + 10 (job B)
    expect(r.shortageQty).toBe("5");
    expect(r.demand.map((d: any) => d.jobId).sort()).toEqual([jobA, jobB].sort());
  });

  it("an item never received is 'no stock recorded', not a zero balance", async () => {
    const r = await row(m2);
    expect(r.hasStockRecord).toBe(false);
    expect(r.onHand).toBe("0");
    expect(r.remainingRequirement).toBe("15");
    expect(r.status).toBe("shortage");
  });

  it("issuing material does not change the shortage: requirement is expected MINUS issued", async () => {
    await issueMaterialToJob(ownerA, jobA, { clientRequestId: randomUUID(), materialItemId: m1, warehouseId: wh1, quantity: 10 });
    const r = await row(m1);
    expect(r.onHand).toBe("15");
    expect(r.remainingRequirement).toBe("20"); // 10 still needed by A + 10 by B (not 30)
    expect(r.shortageQty).toBe("5");
    const a = r.demand.find((d: any) => d.jobId === jobA);
    expect(a.expected).toBe("20");
    expect(a.issued).toBe("10");
    expect(a.remaining).toBe("10");
  });

  it("cancelling a job releases its requirement", async () => {
    await transitionJob(ownerA, jobB, { status: "cancelled", reason: "customer withdrew" });
    const r = await row(m1);
    expect(r.remainingRequirement).toBe("10");
    expect(r.status).toBe("ok");
  });

  it("'low' appears only when a reorder threshold is set, and clears when it is removed", async () => {
    expect((await row(m1)).status).toBe("ok");
    await updateItem(ownerA, m1, { reorderThreshold: 100 });
    const low = await row(m1);
    expect(low.status).toBe("low");
    expect(low.reorderThreshold).toBe("100");
    await updateItem(ownerA, m1, { reorderThreshold: null });
    const cleared = await row(m1);
    expect(cleared.status).toBe("ok");
    expect(cleared.reorderThreshold).toBeNull();
  });

  it("an item with a threshold but no demand is listed once it has stock", async () => {
    const m3 = await createItem(ownerA, { sku: `LOW-${randomUUID().slice(0, 8)}`, itemType: "raw_material", name: "Low item", uom: "kg", reorderThreshold: 50 });
    expect(await row(m3.id)).toBeUndefined(); // never received, no demand: nothing to report
    await rec(m3.id, 10);
    expect((await row(m3.id)).status).toBe("low");
  });

  it("filters by status and sorts shortages first", async () => {
    const shortages = (await getShortages(ownerA, { status: "shortage" })) as any[];
    expect(shortages.every((r) => r.status === "shortage")).toBe(true);
    expect(shortages.some((r) => r.item.id === m2)).toBe(true);
    const all = (await getShortages(ownerA)) as any[];
    const order = all.map((r) => r.status);
    expect(order).toEqual([...order].sort((a, b) => ["shortage", "low", "ok"].indexOf(a) - ["shortage", "low", "ok"].indexOf(b)));
  });

  it("branch and tenant isolation", async () => {
    expect(((await getShortages(inv2)) as any[])).toHaveLength(0); // granted branch 2 only: nothing there
    expect(((await getShortages(ownerA, { branchId: branch2 })) as any[])).toHaveLength(0);
    await expect(getShortages(inv2, { branchId: orgA.branchId })).rejects.toBeInstanceOf(ForbiddenError);
    expect(((await getShortages(ownerB)) as any[])).toHaveLength(0);
  });

  it("capabilities: viewer may read; operator may not", async () => {
    await expect(getShortages(viewer)).resolves.toBeTruthy();
    await expect(getShortages(operator)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
