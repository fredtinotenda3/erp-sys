// Milestone 4 additions layered onto PRE-EXISTING services, grouped in one
// file (rather than four near-empty ones) because each addition is a small,
// independent extension of a service that already has its own full suite:
//   - job-service.ts: ProductionJob.priority
//   - stage-service.ts: ProductionJobStage workCentreId/machineId
//   - labour-service.ts: LabourRecord.jobStageId
//   - bom-service.ts: BomLine.expectedScrapPct/expectedYieldPct, BOM effectiveTo
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { createItem } from "../../catalog/item-service";
import { createBomVersion } from "../../catalog/bom-service";
import { createJob, updateJob, listJobs, transitionJob } from "../job-service";
import { defineStages } from "../stage-service";
import { recordLabour } from "../labour-service";
import { createWorkCentre, createMachine } from "../machine-service";
import { ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

let org: TestOrg;
let owner: AuthenticatedSession;
let mgr: AuthenticatedSession;
let productId: string;

beforeAll(async () => {
  org = await createTestOrg("m4extA");
  owner = await ownerSession(org);
  mgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "m4ext-mgr", [org.branchId]);
  productId = (await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
}, 180_000);

describe("ProductionJob.priority", () => {
  it("defaults to 'normal' when not given, and can be set explicitly on creation", async () => {
    const def = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    expect(def.priority).toBe("normal");
    const urgent = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1, priority: "urgent" })) as any;
    expect(urgent.priority).toBe("urgent");
  });

  it("can be changed via updateJob while the job remains editable", async () => {
    const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    const updated: any = await updateJob(mgr, job.id, { priority: "high" });
    expect(updated.priority).toBe("high");
  });

  it("listJobs can filter by priority", async () => {
    await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1, priority: "low" });
    const u = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1, priority: "urgent" })) as any;
    const result: any[] = await listJobs(owner, { priority: "urgent" });
    expect(result.map((j) => j.id)).toContain(u.id);
  });

  it("rejects an unknown priority value", async () => {
    await expect(createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1, priority: "critical" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("ProductionJobStage workCentreId/machineId (defineStages)", () => {
  it("accepts a stage with a workCentreId and a machineId that belongs to it", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `EXT-WC-${randomUUID()}`, name: "Extrusion" });
    const m: any = await createMachine(mgr, { workCentreId: wc.id, code: `EXT-M-${randomUUID()}`, name: "Line 1" });
    const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    const { stages } = await defineStages(mgr, job.id, {
      stages: [{ name: "Extrude", workCentreId: wc.id, machineId: m.id, expectedSetupMinutes: 15, expectedRunMinutes: 45 }],
    });
    expect(stages[0].workCentreId).toBe(wc.id);
    expect(stages[0].machineId).toBe(m.id);
    expect(stages[0].expectedSetupMinutes).toBe(15);
    expect(stages[0].expectedRunMinutes).toBe(45);
  });

  it("rejects a machineId that does not belong to the named workCentreId", async () => {
    const wc1: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `EXT-WC1-${randomUUID()}`, name: "WC1" });
    const wc2: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `EXT-WC2-${randomUUID()}`, name: "WC2" });
    const mOther: any = await createMachine(mgr, { workCentreId: wc2.id, code: `EXT-M2-${randomUUID()}`, name: "Line in WC2" });
    const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    await expect(defineStages(mgr, job.id, { stages: [{ name: "Mismatch", workCentreId: wc1.id, machineId: mOther.id }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a workCentreId that belongs to a different branch than the job", async () => {
    // Uses `owner` (OWNER_ADMIN) throughout, not `mgr` -- mgr only has
    // access to org.branchId, so calling this with mgr would reject on
    // "can't see that work centre at all" (findWorkCentreInScope) rather
    // than isolating the branch-mismatch check this test is about.
    const branch2 = (await createBranch(owner, { name: "M4Ext Second" })).id;
    const wc: any = await createWorkCentre(owner, { branchId: branch2, code: `EXT-WCB2-${randomUUID()}`, name: "Other branch" });
    const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    await expect(defineStages(owner, job.id, { stages: [{ name: "Cross branch", workCentreId: wc.id }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("the free-text workCentre field and workCentreId are independent -- either, both, or neither may be set", async () => {
    const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    const { stages } = await defineStages(mgr, job.id, { stages: [{ name: "Text only", workCentre: "Paint Booth 3" }] });
    expect(stages[0].workCentre).toBe("Paint Booth 3");
    expect(stages[0].workCentreId).toBeNull();
  });
});

describe("LabourRecord.jobStageId", () => {
  it("attributes a labour record to a specific stage when given", async () => {
    const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    const { stages } = await defineStages(mgr, job.id, { stages: [{ name: "Only stage" }] });
    await transitionJob(owner, job.id, { status: "released" });
    const res = await recordLabour(mgr, job.id, { clientRequestId: randomUUID(), jobStageId: stages[0].id, hours: 1, rate: 10, rateCurrency: "USD" });
    expect((res.record as any).jobStageId).toBe(stages[0].id);
  });

  it("rejects a jobStageId that does not belong to the job", async () => {
    const jobA = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    await transitionJob(owner, jobA.id, { status: "released" });
    const jobB = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    const { stages: stagesB } = await defineStages(mgr, jobB.id, { stages: [{ name: "Belongs to B" }] });
    await expect(recordLabour(mgr, jobA.id, { clientRequestId: randomUUID(), jobStageId: stagesB[0].id, hours: 1, rate: 10, rateCurrency: "USD" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("omitting jobStageId keeps the pre-Milestone-4 meaning: job-level labour, no stage attribution", async () => {
    const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    await transitionJob(owner, job.id, { status: "released" });
    const res = await recordLabour(mgr, job.id, { clientRequestId: randomUUID(), hours: 1, rate: 10, rateCurrency: "USD" });
    expect((res.record as any).jobStageId).toBeNull();
  });
});

describe("BomLine.expectedScrapPct/expectedYieldPct and BillOfMaterial.effectiveTo", () => {
  async function productAndMaterial() {
    const product = await createItem(owner, { sku: `M4EXT-P-${randomUUID()}`, itemType: "finished_good", name: "P", uom: "ea" });
    const material = await createItem(owner, { sku: `M4EXT-M-${randomUUID()}`, itemType: "raw_material", name: "M", uom: "kg" });
    return { product, material };
  }

  it("stores scrap/yield percentages per line and effectiveTo on the version, when given", async () => {
    const { product, material } = await productAndMaterial();
    const bom: any = await createBomVersion(owner, product.id, {
      effectiveTo: "2099-01-01",
      lines: [{ materialItemId: material.id, quantity: 1, uom: "kg", expectedScrapPct: 2.5, expectedYieldPct: 97.5 }],
    });
    expect(bom.effectiveTo).toBeTruthy();
    expect(String(bom.lines[0].expectedScrapPct)).toBe("2.5");
    expect(String(bom.lines[0].expectedYieldPct)).toBe("97.5");
  });

  it("omitting both keeps today's behaviour exactly: both fields are null", async () => {
    const { product, material } = await productAndMaterial();
    const bom: any = await createBomVersion(owner, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }] });
    expect(bom.effectiveTo).toBeNull();
    expect(bom.lines[0].expectedScrapPct).toBeNull();
    expect(bom.lines[0].expectedYieldPct).toBeNull();
  });

  it("rejects a scrap percentage of 100 or more (100% scrap is not a scrap rate, it's a data error)", async () => {
    const { product, material } = await productAndMaterial();
    await expect(
      createBomVersion(owner, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg", expectedScrapPct: 100 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a yield percentage of 0 or less, or over 100", async () => {
    const { product, material } = await productAndMaterial();
    await expect(
      createBomVersion(owner, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg", expectedYieldPct: 0 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createBomVersion(owner, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg", expectedYieldPct: 100.5 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects effectiveTo before effectiveFrom", async () => {
    const { product, material } = await productAndMaterial();
    await expect(
      createBomVersion(owner, product.id, { effectiveFrom: "2030-06-01", effectiveTo: "2030-01-01", lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
