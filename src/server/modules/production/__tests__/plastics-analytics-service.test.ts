// Milestone 6 (Plastics Manufacturing Vertical): plastics production
// analytics -- getPlasticsJobCostSummary. Real-database test, not executed
// in this environment -- see IMPLEMENTATION_MANIFEST.md and
// industry-profile-service.test.ts's header comment for why. Run with
// `npm test -- plastics-analytics-service`.
//
// Covers:
//  - single source of truth: materialCost/labourCost/costPerGoodUnit/
//    goodOutputQty/scrapQty are never re-derived here -- they must equal
//    cost-service.ts's own getJobCost figures for the SAME job, called
//    independently in this test (the mandate's "never double-count
//    material value" / "single source of truth" rule, applied to analytics)
//  - machineCost is always the honest {amount:null, currency:null, basis:
//    "not_available", note:...} shape -- this codebase has no telemetry/
//    PLC/energy-meter integration anywhere, and the mandate forbids
//    inventing such a reading
//  - regrindGeneratedQty: lots with sourceRegrindJobId === this job, summed
//  - regrindConsumedQty: this job's own LotConsumption rows against a lot
//    that is itself regrind-sourced (exercising the service's own "from
//    this job or any other" comment, by issuing from a warehouse that
//    holds only a regrind lot)
//  - a job with no regrind activity at all reports zero for both, never null
//  - production_job:read + cost:read capability requirements
//  - reads are never profile-gated -- this read path has no plastics-
//    specific gate at all, unlike every Milestone 6 WRITE path
//  - tenant isolation
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { sessionWithRole, productWithActiveBom } from "./production-helpers";
import { createJob, transitionJob, completeJob } from "../job-service";
import { recordOutput } from "../output-service";
import { recordLabour } from "../labour-service";
import { createWarehouse } from "../../inventory/warehouse-service";
import { receiveStock } from "../../inventory/stock-service";
import { issueMaterialToJob } from "../../inventory/material-issue-service";
import { createRegrindLot } from "../../inventory/regrind-service";
import { updateIndustryProfile } from "../../industry/industry-profile-service";
import { getJobCost } from "../../costing/cost-service";
import { getPlasticsJobCostSummary } from "../plastics-analytics-service";
import { ForbiddenError, NotFoundError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let org: TestOrg;
let owner: AuthenticatedSession;
let finance: AuthenticatedSession; // production_job:read + cost:read
let inv: AuthenticatedSession; // lacks cost:read
let branchId: string;
let wh1: string;
let wh2: string;
let materialItemId: string;
let jobId: string;

beforeAll(async () => {
  org = await createTestOrg("paA");
  owner = await ownerSession(org);
  finance = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "pa-fin", [org.branchId]);
  inv = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "pa-inv", [org.branchId]);
  await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  branchId = org.branchId;
  wh1 = (await createWarehouse(owner, { branchId, name: "Main store" })).id;
  // A warehouse that will hold ONLY a regrind lot -- so issuing from it
  // necessarily consumes that regrind lot, giving a deterministic
  // regrindConsumedQty without depending on FIFO lot-selection order.
  wh2 = (await createWarehouse(owner, { branchId, name: "Regrind-only store" })).id;

  const { product, materialItems } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 2 }]);
  materialItemId = materialItems[0].id;
  await receiveStock(owner, { clientRequestId: randomUUID(), warehouseId: wh1, itemId: materialItemId, quantity: 100, unitCost: 2, currency: "USD" });

  const job = (await createJob(owner, { branchId, productItemId: product.id, plannedQty: 10 })) as any;
  jobId = job.id;
  await transitionJob(owner, jobId, { status: "released" });
  await issueMaterialToJob(owner, jobId, { clientRequestId: randomUUID(), materialItemId, warehouseId: wh1, quantity: 20 });

  // Two regrind lots sourced from this job's own scrap: one left in wh1
  // (generated, never consumed -> exercises regrindGeneratedQty only), one
  // placed in wh2 and then immediately issued back to the same job (-> also
  // exercises regrindConsumedQty). 5 + 3 = 8 generated; 3 consumed.
  await createRegrindLot(owner, { clientRequestId: randomUUID(), sourceJobId: jobId, itemId: materialItemId, warehouseId: wh1, quantity: 5, unitCost: 1, currency: "USD" });
  await createRegrindLot(owner, { clientRequestId: randomUUID(), sourceJobId: jobId, itemId: materialItemId, warehouseId: wh2, quantity: 3, unitCost: 1, currency: "USD" });
  await issueMaterialToJob(owner, jobId, { clientRequestId: randomUUID(), materialItemId, warehouseId: wh2, quantity: 3 });

  await recordLabour(owner, jobId, { clientRequestId: randomUUID(), hours: 2, rate: 3, rateCurrency: "USD" });
  // No stage on this job -- jobTotals() is simply totalsOf(rows) when a job
  // has no routing, so output can be recorded at the job level directly.
  await recordOutput(owner, jobId, { clientRequestId: randomUUID(), goodQty: 8, scrapQty: 2, reason: "other" });
  // costPerGoodUnit requires the job to be completed (cost-completeness.ts's
  // "job_not_completed" margin blocker) -- done last, after every material/
  // labour/output entry this test depends on.
  await completeJob(owner, jobId);
}, 180_000);

describe("getPlasticsJobCostSummary", () => {
  it("never re-derives cost: material/labour/output/cost-per-good-unit equal cost-service.ts's own getJobCost for the same job", async () => {
    const summary: any = await getPlasticsJobCostSummary(finance, jobId);
    const jobCost: any = await getJobCost(finance, jobId);

    expect(jobCost.lines).toHaveLength(1); // single currency -- USD throughout, so a figure CAN be stated
    const line = jobCost.lines[0];
    expect(summary.materialCost.amount.toString()).toBe(line.adjusted.material);
    expect(summary.materialCost.currency).toBe(line.currency);
    expect(summary.materialCost.basis).toBe("measured");
    expect(summary.labourCost.amount.toString()).toBe(line.adjusted.labour);
    expect(summary.labourCost.currency).toBe(line.currency);

    expect(summary.goodOutputQty.toString()).toBe(jobCost.output.effectiveGood);
    expect(summary.scrapQty.toString()).toBe(jobCost.output.scrap);
    expect(summary.yieldPct.toString()).toBe(jobCost.output.yieldPercent);

    expect(jobCost.output.costPerGoodUnit.available).toBe(true);
    expect(summary.costPerGoodUnit).not.toBeNull();
    expect(summary.costPerGoodUnit.amount.toString()).toBe(jobCost.output.costPerGoodUnit.amount);
    expect(summary.costPerGoodUnit.currency).toBe(jobCost.output.costPerGoodUnit.currency);
  });

  it("scrapRatePct is scrap / processed x 100 -- processed = good(8) + scrap(2) = 10, so 2/10*100 = 20", async () => {
    const summary: any = await getPlasticsJobCostSummary(finance, jobId);
    expect(summary.scrapRatePct.toString()).toBe("20");
  });

  it("machineCost is always the honest not_available shape -- never invented telemetry", async () => {
    const summary: any = await getPlasticsJobCostSummary(finance, jobId);
    expect(summary.machineCost.amount).toBeNull();
    expect(summary.machineCost.currency).toBeNull();
    expect(summary.machineCost.basis).toBe("not_available");
    expect(typeof summary.machineCost.note).toBe("string");
    expect(summary.machineCost.note.length).toBeGreaterThan(0);
  });

  it("regrindGeneratedQty sums regrind lots sourced from this job (5 + 3 = 8 kg)", async () => {
    const summary: any = await getPlasticsJobCostSummary(finance, jobId);
    expect(summary.regrindGeneratedQty.toString()).toBe("8");
  });

  it("regrindConsumedQty sums this job's own consumption of regrind-sourced lots (the 3kg issued from the regrind-only warehouse)", async () => {
    const summary: any = await getPlasticsJobCostSummary(finance, jobId);
    expect(summary.regrindConsumedQty.toString()).toBe("3");
  });

  it("a job with no regrind activity at all reports zero for both regrind quantities, never null", async () => {
    const { product: p2 } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 1 }]);
    const job2 = (await createJob(owner, { branchId, productItemId: p2.id, plannedQty: 1 })) as any;
    const summary: any = await getPlasticsJobCostSummary(finance, job2.id);
    expect(summary.regrindGeneratedQty.toString()).toBe("0");
    expect(summary.regrindConsumedQty.toString()).toBe("0");
  });

  it("requires production_job:read and cost:read", async () => {
    await expect(getPlasticsJobCostSummary(inv, jobId)).rejects.toThrow(ForbiddenError);
  });

  it("reads are never profile-gated -- this read path has no plastics-specific gate at all", async () => {
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
    await expect(getPlasticsJobCostSummary(finance, jobId)).resolves.toBeTruthy();
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  });

  it("404s for a job that does not belong to this organization", async () => {
    await expect(getPlasticsJobCostSummary(finance, randomUUID())).rejects.toThrow(NotFoundError);
  });
});

describe("tenant isolation", () => {
  it("a job from a different organization never resolves", async () => {
    const orgB = await createTestOrg("paB");
    const ownerB = await ownerSession(orgB);
    await expect(getPlasticsJobCostSummary(ownerB, jobId)).rejects.toThrow(NotFoundError);
  });
});
