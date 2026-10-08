/* eslint-disable @typescript-eslint/no-explicit-any -- job/labour views are intentionally loose Record<string, unknown> projections; tests read fields by name */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { listAuditLog } from "../../iam/audit-service";
import { createCustomer, updateCustomer } from "../../customers/customer-service";
import { createItem, updateItem } from "../../catalog/item-service";
import { createBomVersion, activateBomVersion } from "../../catalog/bom-service";
import { createJob, getJob, listJobs, transitionJob, completeJob } from "../job-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

// Shared, read-mostly fixture. Creating orgs/users is slow against a remote
// database, so it is built once and individual tests create their own jobs.
let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let branch2Id: string;
let prodMgr: AuthenticatedSession; // main branch
let prodMgr2: AuthenticatedSession; // branch 2 only
let operator: AuthenticatedSession;
let viewer: AuthenticatedSession;
let inventoryMgr: AuthenticatedSession;
let finance: AuthenticatedSession;
let twoCurrencyProduct: Awaited<ReturnType<typeof productWithActiveBom>>;
let customerId: string;

const MAIN = () => orgA.branchId;

beforeAll(async () => {
  orgA = await createTestOrg("prodA");
  orgB = await createTestOrg("prodB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  branch2Id = (await createBranch(ownerA, { name: "Second" })).id;

  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
  prodMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm2", [branch2Id]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "vw", [orgA.branchId]);
  inventoryMgr = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "im", [orgA.branchId]);
  finance = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fm", [orgA.branchId]);

  // 2 kg x 2.50 USD + 1 ea x 100 ZIG per unit => two currencies, never blended.
  twoCurrencyProduct = await productWithActiveBom(ownerA, [
    { uom: "kg", standardCost: 2.5, standardCostCurrency: "USD", bomQty: 2 },
    { uom: "ea", standardCost: 100, standardCostCurrency: "ZIG", bomQty: 1 },
  ]);
  customerId = (await createCustomer(ownerA, { name: "Chido Furnishings" })).id;
}, 180_000);

function newJob(session = ownerA, extra: Record<string, unknown> = {}) {
  return createJob(session, { branchId: MAIN(), productItemId: twoCurrencyProduct.product.id, plannedQty: 10, ...extra });
}

describe("createJob", () => {
  it("snapshots BOM quantities and builds a per-currency estimate (no blending)", async () => {
    const job = (await newJob()) as Record<string, any>;
    expect(job.jobNumber).toMatch(/^JOB-\d{5}$/);
    expect(job.status).toBe("planned");
    expect(job.bomId).toBe(twoCurrencyProduct.bom.id);

    const reqs = job.materialRequirements as any[];
    expect(reqs).toHaveLength(2);
    const byItem = new Map(reqs.map((r) => [r.materialItemId, r]));
    expect(String(byItem.get(twoCurrencyProduct.materialItems[0].id).expectedQty)).toBe("20"); // 2 x 10
    expect(String(byItem.get(twoCurrencyProduct.materialItems[1].id).expectedQty)).toBe("10"); // 1 x 10

    const lines = job.costEstimate.lines as any[];
    expect(lines).toHaveLength(2);
    const usd = lines.find((l) => l.currency === "USD");
    const zig = lines.find((l) => l.currency === "ZIG");
    expect(String(usd.estimatedMaterialCost)).toBe("50"); // 20 kg x 2.50
    expect(String(zig.estimatedMaterialCost)).toBe("1000"); // 10 ea x 100
    // Labour and overhead are UNAVAILABLE (null), never 0.
    expect(usd.estimatedLabourCost).toBeNull();
    expect(usd.estimatedOverheadCost).toBeNull();
    expect(job.costEstimate.isMaterialEstimateComplete).toBe(true);
  });

  it("records an audit entry for creation", async () => {
    const job = (await newJob()) as Record<string, any>;
    const entries = await listAuditLog(ownerA, { entityType: "production_job", entityId: job.id });
    expect(entries.some((e: any) => e.action === "create")).toBe(true);
  });

  it("reports unpriced materials instead of guessing: missing cost and unit mismatch", async () => {
    const p = await productWithActiveBom(ownerA, [
      { uom: "kg", bomQty: 1 }, // no standard cost
      { uom: "kg", standardCost: 5, standardCostCurrency: "USD", bomQty: 1, bomUom: "m" }, // BOM unit differs from cost unit
    ]);
    const job = (await createJob(ownerA, { branchId: MAIN(), productItemId: p.product.id, plannedQty: 3 })) as Record<string, any>;
    expect(job.costEstimate.lines).toHaveLength(0); // nothing priced => no figures at all, not zeros
    expect(job.costEstimate.isMaterialEstimateComplete).toBe(false);
    const reasons = (job.costEstimate.unpricedMaterials as any[]).map((u) => u.reason).sort();
    expect(reasons).toEqual(["no_standard_cost", "uom_mismatch"]);
  });

  it("prices what it can and still lists what it cannot", async () => {
    const p = await productWithActiveBom(ownerA, [
      { uom: "kg", standardCost: 4, standardCostCurrency: "USD", bomQty: 1 },
      { uom: "kg", bomQty: 1 },
    ]);
    const job = (await createJob(ownerA, { branchId: MAIN(), productItemId: p.product.id, plannedQty: 5 })) as Record<string, any>;
    expect(job.costEstimate.lines).toHaveLength(1);
    expect(String(job.costEstimate.lines[0].estimatedMaterialCost)).toBe("20");
    expect(job.costEstimate.isMaterialEstimateComplete).toBe(false);
  });

  it("generates distinct, gap-free job numbers under concurrent creation", async () => {
    const p = await productWithActiveBom(ownerB, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createJob(ownerB, { branchId: orgB.branchId, productItemId: p.product.id, plannedQty: 1 })),
    );
    const numbers = results.map((r: any) => Number(r.jobNumber.replace("JOB-", ""))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers[4] - numbers[0]).toBe(4); // consecutive
    expect(numbers[0]).toBe(1); // org B's first five jobs: its own counter, independent of org A
  });

  it("BOM snapshot immutability: later BOM and cost changes never alter an existing job", async () => {
    const p = await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 1 }]);
    const oldJob = (await createJob(ownerA, { branchId: MAIN(), productItemId: p.product.id, plannedQty: 10 })) as Record<string, any>;

    // New BOM version with a different quantity, activated; and a price change.
    const v2 = await createBomVersion(ownerA, p.product.id, {
      lines: [{ materialItemId: p.materialItems[0].id, quantity: 5, uom: "kg" }],
    });
    await activateBomVersion(ownerA, p.product.id, v2!.id);
    await updateItem(ownerA, p.materialItems[0].id, { standardCost: 99, standardCostCurrency: "USD" });

    const reread = (await getJob(ownerA, oldJob.id)) as Record<string, any>;
    expect(reread.bomId).toBe(p.bom.id); // still version 1
    expect(String(reread.materialRequirements[0].expectedQty)).toBe("10");
    expect(String(reread.materialRequirements[0].standardUnitCost)).toBe("2");
    expect(String(reread.costEstimate.lines[0].estimatedMaterialCost)).toBe("20");

    // A NEW job picks up the new version and the new price.
    const newJob2 = (await createJob(ownerA, { branchId: MAIN(), productItemId: p.product.id, plannedQty: 10 })) as Record<string, any>;
    expect(newJob2.bomId).toBe(v2!.id);
    expect(String(newJob2.materialRequirements[0].expectedQty)).toBe("50");
    expect(String(newJob2.costEstimate.lines[0].estimatedMaterialCost)).toBe("4950");
  });

  it("refuses an item with no active BOM", async () => {
    const bare = await createItem(ownerA, { sku: `BARE-${Date.now()}`, itemType: "finished_good", name: "No BOM", uom: "ea" });
    await expect(createJob(ownerA, { branchId: MAIN(), productItemId: bare.id, plannedQty: 1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses to produce a raw material", async () => {
    await expect(
      createJob(ownerA, { branchId: MAIN(), productItemId: twoCurrencyProduct.materialItems[0].id, plannedQty: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates quote pairing, dates, quantity and currency", async () => {
    const base = { branchId: MAIN(), productItemId: twoCurrencyProduct.product.id, plannedQty: 1 };
    await expect(createJob(ownerA, { ...base, quotedAmount: 100 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createJob(ownerA, { ...base, quotedAmount: 100, quotedCurrency: "XXX" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createJob(ownerA, { ...base, plannedStart: "2026-10-10", plannedEnd: "2026-10-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createJob(ownerA, { ...base, plannedQty: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createJob(ownerA, { ...base, plannedQty: -2 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("customer and quote are optional; when given, authorised callers see them", async () => {
    const plain = (await newJob()) as Record<string, any>;
    expect(plain.customerId).toBeNull();
    expect(plain.quotedAmount).toBeNull();

    const full = (await newJob(ownerA, { customerId, quotedAmount: 750, quotedCurrency: "USD" })) as Record<string, any>;
    expect(full.customerId).toBe(customerId);
    expect(String(full.quotedAmount)).toBe("750");
    expect(full.quotedCurrency).toBe("USD");
  });

  it("rejects an inactive customer and a customer from another organization", async () => {
    const c = await createCustomer(ownerA, { name: "Dormant Ltd" });
    await updateCustomer(ownerA, c.id, { status: "inactive" });
    await expect(newJob(ownerA, { customerId: c.id })).rejects.toBeInstanceOf(ValidationError);

    const foreign = await createCustomer(ownerB, { name: "Other Tenant Customer" });
    await expect(newJob(ownerA, { customerId: foreign.id })).rejects.toBeInstanceOf(ValidationError);
  });

  it("capability matrix for creating jobs", async () => {
    await expect(newJob(prodMgr)).resolves.toBeTruthy();
    for (const s of [operator, viewer, inventoryMgr, finance]) {
      await expect(newJob(s)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("tenant isolation", () => {
  it("org B cannot read, list or build on org A's jobs and items", async () => {
    const job = (await newJob()) as Record<string, any>;
    await expect(getJob(ownerB, job.id)).rejects.toBeInstanceOf(NotFoundError);
    const listed = (await listJobs(ownerB)) as any[];
    expect(listed.some((j) => j.id === job.id)).toBe(false);
    await expect(
      createJob(ownerB, { branchId: orgB.branchId, productItemId: twoCurrencyProduct.product.id, plannedQty: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(transitionJob(ownerB, job.id, { status: "released" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("branch isolation (within one organization)", () => {
  it("a manager granted only branch 2 cannot see or touch branch-1 jobs", async () => {
    const job = (await newJob()) as Record<string, any>;

    await expect(getJob(prodMgr2, job.id)).rejects.toBeInstanceOf(NotFoundError); // existence not disclosed
    await expect(transitionJob(prodMgr2, job.id, { status: "released" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(newJob(prodMgr2)).rejects.toBeInstanceOf(ForbiddenError); // main branch
    await expect(listJobs(prodMgr2, { branchId: MAIN() })).rejects.toBeInstanceOf(ForbiddenError);

    const visible = (await listJobs(prodMgr2)) as any[];
    expect(visible.some((j) => j.id === job.id)).toBe(false);
  });

  it("each branch's manager sees their own branch's job; the owner sees both", async () => {
    const p2job = (await createJob(prodMgr2, { branchId: branch2Id, productItemId: twoCurrencyProduct.product.id, plannedQty: 1 })) as Record<string, any>;
    const mainJob = (await newJob()) as Record<string, any>;

    expect(((await listJobs(prodMgr2)) as any[]).some((j) => j.id === p2job.id)).toBe(true);
    expect(((await listJobs(prodMgr)) as any[]).some((j) => j.id === p2job.id)).toBe(false);

    const ownerSees = ((await listJobs(ownerA)) as any[]).map((j) => j.id);
    expect(ownerSees).toContain(p2job.id);
    expect(ownerSees).toContain(mainJob.id);
  });
});

describe("reduced views by capability", () => {
  it("an operator sees no customer, quote, or any cost field", async () => {
    const job = (await newJob(ownerA, { customerId, quotedAmount: 900, quotedCurrency: "USD" })) as Record<string, any>;
    const v = (await getJob(operator, job.id)) as Record<string, any>;

    expect(v.jobNumber).toBe(job.jobNumber);
    expect(v.materialRequirements).toHaveLength(2);
    expect(v.materialRequirements[0].expectedQty).toBeDefined();
    for (const key of ["customerId", "salesOrderLineId", "quotedAmount", "quotedCurrency", "costEstimate"]) {
      expect(key in v).toBe(false);
    }
    for (const r of v.materialRequirements) {
      expect("standardUnitCost" in r).toBe(false);
      expect("standardUnitCostCurrency" in r).toBe(false);
    }
    const listed = ((await listJobs(operator)) as any[]).find((j) => j.id === job.id);
    expect(listed).toBeDefined();
    expect("quotedAmount" in listed).toBe(false);
    expect("costEstimate" in listed).toBe(false);
  });

  it("a viewer sees the customer but no cost; inventory manager sees neither; finance sees both", async () => {
    const job = (await newJob(ownerA, { customerId, quotedAmount: 900, quotedCurrency: "USD" })) as Record<string, any>;

    const v = (await getJob(viewer, job.id)) as Record<string, any>;
    expect(v.customerId).toBe(customerId);
    expect("quotedAmount" in v).toBe(false);
    expect("costEstimate" in v).toBe(false);

    const im = (await getJob(inventoryMgr, job.id)) as Record<string, any>;
    expect("customerId" in im).toBe(false);
    expect("quotedAmount" in im).toBe(false);

    const f = (await getJob(finance, job.id)) as Record<string, any>;
    expect(f.customerId).toBe(customerId);
    expect(String(f.quotedAmount)).toBe("900");
    expect(f.costEstimate.lines).toHaveLength(2);
  });
});

describe("state machine through the service", () => {
  it("walks the happy path and records before/after in the audit log", async () => {
    const job = (await newJob()) as Record<string, any>;
    const id = job.id;

    expect(((await transitionJob(prodMgr, id, { status: "released" })) as any).status).toBe("released");
    const started = (await transitionJob(prodMgr, id, { status: "in_progress" })) as Record<string, any>;
    expect(started.status).toBe("in_progress");
    expect(started.actualStart).toBeTruthy();

    const done = (await completeJob(prodMgr, id)) as Record<string, any>;
    expect(done.status).toBe("completed");
    expect(done.actualEnd).toBeTruthy();

    expect(((await transitionJob(prodMgr, id, { status: "closed" })) as any).status).toBe("closed");

    const entries = (await listAuditLog(ownerA, { entityType: "production_job", entityId: id })) as any[];
    const transitions = entries.filter((e) => e.action === "transition");
    expect(transitions).toHaveLength(4);
    expect(transitions.some((t) => t.beforeValue?.status === "in_progress" && t.afterValue?.status === "completed")).toBe(true);
  });

  it("rejects illegal moves: skipping, cancelling in progress, anything after closed", async () => {
    const job = (await newJob()) as Record<string, any>;
    await expect(transitionJob(prodMgr, job.id, { status: "in_progress" })).rejects.toBeInstanceOf(ConflictError);
    await transitionJob(prodMgr, job.id, { status: "released" });
    await transitionJob(prodMgr, job.id, { status: "in_progress" });
    await expect(transitionJob(prodMgr, job.id, { status: "cancelled", reason: "oops" })).rejects.toBeInstanceOf(ConflictError);
    await completeJob(prodMgr, job.id);
    await expect(completeJob(prodMgr, job.id)).rejects.toBeInstanceOf(ConflictError);
    await transitionJob(prodMgr, job.id, { status: "closed" });
    await expect(transitionJob(prodMgr, job.id, { status: "released" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("completion is not reachable through the generic transition endpoint", async () => {
    const job = (await newJob()) as Record<string, any>;
    await transitionJob(prodMgr, job.id, { status: "released" });
    await transitionJob(prodMgr, job.id, { status: "in_progress" });
    await expect(transitionJob(prodMgr, job.id, { status: "completed" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires a reason to hold or cancel, and on_hold returns to the right state", async () => {
    const job = (await newJob()) as Record<string, any>;
    await transitionJob(prodMgr, job.id, { status: "released" });
    await expect(transitionJob(prodMgr, job.id, { status: "on_hold" })).rejects.toBeInstanceOf(ValidationError);
    await transitionJob(prodMgr, job.id, { status: "on_hold", reason: "waiting on timber" });
    // never started => resumes to released, not in_progress
    expect(((await transitionJob(prodMgr, job.id, { status: "released" })) as any).status).toBe("released");
    await expect(transitionJob(prodMgr, job.id, { status: "cancelled" })).rejects.toBeInstanceOf(ValidationError);
    expect(((await transitionJob(prodMgr, job.id, { status: "cancelled", reason: "customer withdrew" })) as any).status).toBe("cancelled");
  });

  it("a job that already started resumes to in_progress after a hold", async () => {
    const job = (await newJob()) as Record<string, any>;
    await transitionJob(prodMgr, job.id, { status: "released" });
    await transitionJob(prodMgr, job.id, { status: "in_progress" });
    await transitionJob(prodMgr, job.id, { status: "on_hold", reason: "machine down" });
    await expect(transitionJob(prodMgr, job.id, { status: "released" })).rejects.toBeInstanceOf(ConflictError);
    expect(((await transitionJob(prodMgr, job.id, { status: "in_progress" })) as any).status).toBe("in_progress");
  });

  it("two simultaneous identical transitions: exactly one wins", async () => {
    const job = (await newJob()) as Record<string, any>;
    const results = await Promise.allSettled([
      transitionJob(prodMgr, job.id, { status: "released" }),
      transitionJob(ownerA, job.id, { status: "released" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
  });

  it("capabilities: operator, viewer, inventory and finance cannot transition or complete", async () => {
    const job = (await newJob()) as Record<string, any>;
    for (const s of [operator, viewer, inventoryMgr, finance]) {
      await expect(transitionJob(s, job.id, { status: "released" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(completeJob(s, job.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
