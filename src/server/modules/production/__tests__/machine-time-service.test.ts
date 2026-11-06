// Milestone 4: actual setup/run minutes against a job, optionally
// attributed to a stage. Same idempotency discipline as labour-service.ts's
// recordLabour -- this suite mirrors labour-service.test.ts's shape.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createWorkCentre, createMachine } from "../machine-service";
import { createJob, transitionJob, completeJob } from "../job-service";
import { defineStages } from "../stage-service";
import { recordMachineTime, listMachineTime } from "../machine-time-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

let org: TestOrg;
let owner: AuthenticatedSession;
let mgr: AuthenticatedSession;
let operator: AuthenticatedSession; // machine_time:record
let viewer: AuthenticatedSession; // neither machine_time:record nor production_job:update, but DOES have production_job:read
let productId: string;
let machineId: string;

beforeAll(async () => {
  org = await createTestOrg("mtA");
  owner = await ownerSession(org);
  mgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "mt-mgr", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "mt-op", [org.branchId]);
  viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "mt-vw", [org.branchId]);
  productId = (await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
  const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: "MT-WC", name: "MT work centre" });
  const m: any = await createMachine(mgr, { workCentreId: wc.id, code: "MT-M", name: "MT machine" });
  machineId = m.id;
}, 180_000);

async function releasedJob(withStage = false): Promise<{ jobId: string; stageId: string | null }> {
  const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
  let stageId: string | null = null;
  if (withStage) {
    const stages = (await defineStages(mgr, job.id, { stages: [{ name: "Run" }] })).stages;
    stageId = stages[0].id;
  }
  await transitionJob(owner, job.id, { status: "released" });
  return { jobId: job.id as string, stageId };
}

const payload = (over: Record<string, unknown> = {}) => ({ clientRequestId: randomUUID(), machineId, setupMinutes: 10, runMinutes: 20, ...over });

describe("recordMachineTime", () => {
  it("records setup/run minutes against a job and audits it", async () => {
    const { jobId } = await releasedJob();
    const res = await recordMachineTime(operator, jobId, payload());
    expect(res.replayed).toBe(false);
    expect(res.record.setupMinutes).toBe(10);
    expect(res.record.runMinutes).toBe(20);
    expect(res.record.operatorUserId).toBe(operator.userId);
  });

  it("is idempotent: the same clientRequestId returns the original row and writes nothing new", async () => {
    const { jobId } = await releasedJob();
    const p = payload();
    const first = await recordMachineTime(operator, jobId, p);
    const second = await recordMachineTime(operator, jobId, p);
    expect(second.replayed).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    const { entries } = await listMachineTime(mgr, jobId);
    expect(entries).toHaveLength(1);
  });

  it("concurrent identical submissions create exactly one record", async () => {
    const { jobId } = await releasedJob();
    const p = payload();
    const results = await Promise.all([recordMachineTime(operator, jobId, p), recordMachineTime(operator, jobId, p), recordMachineTime(operator, jobId, p)]);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it("rejects reuse of a clientRequestId for different data", async () => {
    const { jobId } = await releasedJob();
    const p = payload();
    await recordMachineTime(operator, jobId, p);
    await expect(recordMachineTime(operator, jobId, { ...p, runMinutes: 99 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("requires at least one of setup or run minutes to be positive", async () => {
    const { jobId } = await releasedJob();
    await expect(recordMachineTime(operator, jobId, payload({ setupMinutes: 0, runMinutes: 0 }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates minutes are whole numbers in [0, 1440]", async () => {
    const { jobId } = await releasedJob();
    await expect(recordMachineTime(operator, jobId, payload({ setupMinutes: -1 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(recordMachineTime(operator, jobId, payload({ runMinutes: 1441 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(recordMachineTime(operator, jobId, payload({ setupMinutes: 1.5 }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an unknown or inaccessible machineId", async () => {
    const { jobId } = await releasedJob();
    await expect(recordMachineTime(operator, jobId, payload({ machineId: "00000000-0000-0000-0000-000000000000" }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts an optional jobStageId that belongs to the job, and rejects one that does not", async () => {
    const { jobId, stageId } = await releasedJob(true);
    const res = await recordMachineTime(operator, jobId, payload({ jobStageId: stageId }));
    expect(res.record.jobStageId).toBe(stageId);

    const other = await releasedJob(true);
    await expect(recordMachineTime(operator, jobId, payload({ jobStageId: other.stageId }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("only released or in-progress jobs accept machine time", async () => {
    const planned = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
    await expect(recordMachineTime(operator, planned.id, payload())).rejects.toBeInstanceOf(ConflictError);

    const { jobId } = await releasedJob();
    await recordMachineTime(operator, jobId, payload());
    await completeJob(mgr, jobId);
    await expect(recordMachineTime(operator, jobId, payload())).rejects.toBeInstanceOf(ConflictError);
  });

  it("capabilities: only machine_time:record may record; a viewer may not", async () => {
    const { jobId } = await releasedJob();
    await expect(recordMachineTime(viewer, jobId, payload())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("branch and tenant isolation: not found for a job outside scope", async () => {
    const orgB = await createTestOrg("mtB");
    const ownerB = await ownerSession(orgB);
    const { jobId } = await releasedJob();
    await expect(recordMachineTime(ownerB, jobId, payload())).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listMachineTime", () => {
  it("returns entries newest-first with setup/run totals", async () => {
    const { jobId } = await releasedJob();
    await recordMachineTime(operator, jobId, payload({ setupMinutes: 5, runMinutes: 15 }));
    await recordMachineTime(operator, jobId, payload({ setupMinutes: 7, runMinutes: 3 }));
    const { entries, totals } = await listMachineTime(mgr, jobId);
    expect(entries).toHaveLength(2);
    expect(totals.setupMinutes).toBe(12);
    expect(totals.runMinutes).toBe(18);
  });

  it("respects tenant isolation (every role has production_job:read, so only isolation is independently testable here)", async () => {
    const { jobId } = await releasedJob();
    const orgB = await createTestOrg("mtListB");
    const ownerB = await ownerSession(orgB);
    await expect(listMachineTime(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
