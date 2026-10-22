/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { prisma } from "../../../shared/db";
import { createItem } from "../../catalog/item-service";
import { createBomVersion, activateBomVersion } from "../../catalog/bom-service";
import { createJob, transitionJob, completeJob, getJob } from "../job-service";
import { recordLabour } from "../labour-service";
import { createWarehouse } from "../../inventory/warehouse-service";
import { receiveStock } from "../../inventory/stock-service";
import { issueMaterialToJob } from "../../inventory/material-issue-service";
import { defineStages, listStages, transitionStage } from "../stage-service";
import { listOutput, recordOutput, voidOutput } from "../output-service";
import { listInspections, recordDisposition, recordInspection } from "../quality-service";
import { getJobReadiness } from "../readiness-api";
import { getJobCost } from "../../costing/cost-service";
import { recordCostAdjustment } from "../../costing/cost-adjustment-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import { capabilitiesFor } from "../../../shared/authz";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

let org: TestOrg;
let orgB: TestOrg;
let owner: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let mgr: AuthenticatedSession; // production manager: update + approve + record
let operator: AuthenticatedSession; // output:record, stage:transition, quality:record (no approve, no update)
let viewer: AuthenticatedSession;
let finance: AuthenticatedSession;
let otherBranch: AuthenticatedSession;
let wh: string;
let product: Awaited<ReturnType<typeof productWithActiveBom>>;

const uid = () => randomUUID();
const STAGES = [
  { name: "Cut", requiresInspection: false },
  { name: "Weld", requiresInspection: true },
  { name: "Paint", requiresInspection: false },
];

async function newJob(plannedQty = 20, p = product): Promise<string> {
  return ((await createJob(owner, { branchId: org.branchId, productItemId: p.product.id, plannedQty })) as any).id;
}
async function released(plannedQty = 20, stages: { name: string; requiresInspection?: boolean }[] | null = STAGES): Promise<{ jobId: string; stageIds: string[] }> {
  const jobId = await newJob(plannedQty);
  let stageIds: string[] = [];
  if (stages) stageIds = (await defineStages(mgr, jobId, { stages })).stages.map((s) => s.id);
  await transitionJob(owner, jobId, { status: "released" });
  return { jobId, stageIds };
}
const out = (s: AuthenticatedSession, jobId: string, body: Record<string, unknown>) => recordOutput(s, jobId, { clientRequestId: uid(), ...body });
const insp = (s: AuthenticatedSession, jobId: string, body: Record<string, unknown>) => recordInspection(s, jobId, { clientRequestId: uid(), ...body });
const disp = (s: AuthenticatedSession, jobId: string, inspectionId: string, body: Record<string, unknown>) =>
  recordDisposition(s, jobId, inspectionId, { clientRequestId: uid(), reason: "Approved by supervisor", ...body });
const act = (s: AuthenticatedSession, jobId: string, stageId: string, action: string, extra: Record<string, unknown> = {}) => transitionStage(s, jobId, stageId, { action, ...extra });

beforeAll(async () => {
  org = await createTestOrg("sf3A");
  orgB = await createTestOrg("sf3B");
  owner = await ownerSession(org);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(owner, { name: "Second" })).id;
  wh = (await createWarehouse(owner, { branchId: org.branchId, name: "Main store" })).id;
  mgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "mgr", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "op", [org.branchId]);
  viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "vw", [org.branchId]);
  finance = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "fin", [org.branchId]);
  otherBranch = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "ob", [branch2]);
  product = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 2 }]);
  await receiveStock(owner, { clientRequestId: uid(), warehouseId: wh, itemId: product.materialItems[0].id, quantity: 10_000, unitCost: 2, currency: "USD" });
}, 300_000);

// ---------------------------------------------------------------------------
describe("capabilities", () => {
  it("shop-floor rights are held by the intended roles only", () => {
    expect(capabilitiesFor("PRODUCTION_OPERATOR")).toEqual(expect.arrayContaining(["output:record", "stage:transition", "quality:record"]));
    expect(capabilitiesFor("PRODUCTION_OPERATOR")).not.toContain("quality:approve");
    for (const r of ["OWNER_ADMIN", "OPERATIONS_MANAGER", "PRODUCTION_MANAGER"] as const) expect(capabilitiesFor(r)).toContain("quality:approve");
    for (const r of ["INVENTORY_MANAGER", "FINANCE_MANAGER", "VIEWER"] as const) {
      expect(capabilitiesFor(r)).not.toContain("quality:approve");
      expect(capabilitiesFor(r)).not.toContain("output:record");
    }
  });
});

// ---------------------------------------------------------------------------
describe("stages: definition", () => {
  it("a manager defines the routing; an operator cannot", async () => {
    const jobId = await newJob();
    await expect(defineStages(operator, jobId, { stages: STAGES })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(defineStages(viewer, jobId, { stages: STAGES })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await defineStages(mgr, jobId, { stages: STAGES });
    expect(r.stages.map((s) => [s.sequence, s.name, s.status, s.requiresInspection])).toEqual([
      [1, "Cut", "pending", false],
      [2, "Weld", "pending", true],
      [3, "Paint", "pending", false],
    ]);
    const audit = await prisma.auditLog.count({ where: { entityType: "production_job_stage", action: "create", entityId: { in: r.stages.map((s) => s.id) } } });
    expect(audit).toBe(3);
  });

  it("validates names, dates and assignees", async () => {
    const jobId = await newJob();
    await expect(defineStages(mgr, jobId, { stages: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(defineStages(mgr, jobId, { stages: [{ name: "Cut" }, { name: "cut" }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(defineStages(mgr, jobId, { stages: [{ name: "A", plannedStart: "2026-10-10", plannedEnd: "2026-10-01" }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(defineStages(mgr, jobId, { stages: [{ name: "A", operatorUserId: uid() }] })).rejects.toBeInstanceOf(ValidationError);
    // a user who has no access to this job's branch can't be assigned to it
    await expect(defineStages(mgr, jobId, { stages: [{ name: "A", operatorUserId: otherBranch.userId }] })).rejects.toBeInstanceOf(ValidationError);
    const ok = await defineStages(mgr, jobId, { stages: [{ name: "A", operatorUserId: operator.userId, workCentre: "Bay 3", plannedEnd: "2000-01-01" }] });
    expect(ok.stages[0]).toMatchObject({ operatorUserId: operator.userId, workCentre: "Bay 3", isDelayed: true });
  });

  it("can be redefined until work starts, and not afterwards", async () => {
    const jobId = await newJob();
    await defineStages(mgr, jobId, { stages: [{ name: "One" }] });
    const second = await defineStages(mgr, jobId, { stages: [{ name: "X" }, { name: "Y" }] });
    expect(second.stages.map((s) => s.name)).toEqual(["X", "Y"]);
    await transitionJob(owner, jobId, { status: "released" });
    await act(operator, jobId, second.stages[0].id, "start");
    await expect(defineStages(mgr, jobId, { stages: [{ name: "Z" }] })).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("stages: transitions", () => {
  it("run strictly in sequence; the first start moves the job into progress", async () => {
    const { jobId, stageIds } = await released();
    await expect(act(operator, jobId, stageIds[1], "start")).rejects.toThrow(/must be completed first/);
    const started = await act(operator, jobId, stageIds[0], "start");
    expect(started).toMatchObject({ status: "in_progress", operatorUserId: operator.userId });
    expect(started.startedAt).toBeTruthy();
    const job = (await getJob(owner, jobId)) as any;
    expect(job.status).toBe("in_progress");
    expect(job.actualStart).toBeTruthy();
    await expect(act(operator, jobId, stageIds[0], "start")).rejects.toBeInstanceOf(ConflictError);
  });

  it("a stage cannot be completed by flipping a status: it needs recorded output", async () => {
    const { jobId, stageIds } = await released();
    await act(operator, jobId, stageIds[0], "start");
    await expect(act(operator, jobId, stageIds[0], "complete")).rejects.toThrow(/No output has been recorded/);
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 20 });
    const done = await act(operator, jobId, stageIds[0], "complete");
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeTruthy();
  });

  it("a stage that requires inspection cannot complete without a passing inspection of every good unit", async () => {
    const { jobId, stageIds } = await released();
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 20 });
    await act(operator, jobId, stageIds[0], "complete");
    await act(operator, jobId, stageIds[1], "start");
    await out(operator, jobId, { jobStageId: stageIds[1], goodQty: 20 });
    await expect(act(operator, jobId, stageIds[1], "complete")).rejects.toThrow(/requires an inspection/);
    await insp(operator, jobId, { jobStageId: stageIds[1], inspectedQty: 12 });
    await expect(act(operator, jobId, stageIds[1], "complete")).rejects.toThrow(/8 good unit\(s\) .* have not been inspected/);
    await insp(operator, jobId, { jobStageId: stageIds[1], inspectedQty: 8 });
    expect((await act(operator, jobId, stageIds[1], "complete")).status).toBe("completed");
  });

  it("blocking needs a reason, freezes the stage, and unblocking restores it", async () => {
    const { jobId, stageIds } = await released();
    await act(operator, jobId, stageIds[0], "start");
    await expect(act(operator, jobId, stageIds[0], "block")).rejects.toBeInstanceOf(ValidationError);
    const b = await act(operator, jobId, stageIds[0], "block", { reason: "Waiting for jig" });
    expect(b.blockedReason).toBe("Waiting for jig");
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toThrow(/blocked/);
    await expect(act(operator, jobId, stageIds[0], "complete")).rejects.toThrow(/blocked/);
    await expect(act(operator, jobId, stageIds[0], "block", { reason: "again" })).rejects.toBeInstanceOf(ConflictError);
    await act(operator, jobId, stageIds[0], "unblock");
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1 })).resolves.toBeTruthy();
    await expect(act(operator, jobId, stageIds[0], "unblock")).rejects.toBeInstanceOf(ConflictError);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "production_job_stage", entityId: stageIds[0] }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["create", "transition", "update", "update"]);
  });

  it("the database refuses illegal transitions and edits to a final stage, even for direct writes", async () => {
    const { jobId, stageIds } = await released();
    await expect(prisma.productionJobStage.update({ where: { id: stageIds[0] }, data: { status: "completed", startedAt: new Date(), completedAt: new Date() } })).rejects.toBeTruthy();
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 5 });
    await act(operator, jobId, stageIds[0], "complete");
    await expect(prisma.productionJobStage.update({ where: { id: stageIds[0] }, data: { notes: "tamper" } })).rejects.toBeTruthy();
    await expect(prisma.productionJobStage.update({ where: { id: stageIds[0] }, data: { status: "in_progress", completedAt: null } })).rejects.toBeTruthy();
    await expect(prisma.productionJobStage.delete({ where: { id: stageIds[0] } })).rejects.toBeTruthy();
  });

  it("a job that is on hold accepts no shop-floor work", async () => {
    const { jobId, stageIds } = await released();
    await act(operator, jobId, stageIds[0], "start");
    await transitionJob(mgr, jobId, { status: "on_hold", reason: "Customer change" });
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toBeInstanceOf(ConflictError);
    await expect(act(operator, jobId, stageIds[0], "complete")).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
describe("output: validation", () => {
  let jobId: string;
  let stageIds: string[];
  beforeAll(async () => {
    ({ jobId, stageIds } = await released());
    await act(operator, jobId, stageIds[0], "start");
  });

  it("rejects negative, non-numeric, over-precise and all-zero quantities", async () => {
    for (const bad of [{ goodQty: -1 }, { goodQty: 1, scrapQty: -0.5, reason: "damaged" }, { goodQty: 1.00001 }, { goodQty: "5" }, {}, { goodQty: 0 }]) {
      await expect(out(operator, jobId, { jobStageId: stageIds[0], ...bad })).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("scrap and rework need a reason; subsets can't exceed their parent", async () => {
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1, scrapQty: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1, reworkQty: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1, reworkGoodQty: 2 })).rejects.toBeInstanceOf(ValidationError);
    await expect(out(operator, jobId, { jobStageId: stageIds[0], scrapQty: 1, reason: "damaged", reworkScrapQty: 2 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("units can't come back from rework that were never sent", async () => {
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1, reworkGoodQty: 1 })).rejects.toThrow(/resolved from rework/);
  });

  it("uses the product's own unit of measure and refuses a different one", async () => {
    await expect(out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1, uom: "kg" })).rejects.toThrow(/recorded in ea/);
    const r = await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1, uom: "ea" });
    expect(r.entry.uom).toBe("ea");
  });

  it("units differ per product: a metre-based product records in metres", async () => {
    const cable = await createItem(owner, { sku: `CAB-${uid().slice(0, 6)}`, itemType: "finished_good", name: "Cable", uom: "m" });
    const bom = await createBomVersion(owner, cable.id, { lines: [{ materialItemId: product.materialItems[0].id, quantity: 1, uom: "kg" }] });
    await activateBomVersion(owner, cable.id, bom!.id);
    const j = ((await createJob(owner, { branchId: org.branchId, productItemId: cable.id, plannedQty: 100 })) as any).id;
    await transitionJob(owner, j, { status: "released" });
    expect((await out(operator, j, { goodQty: 12.5 })).entry.uom).toBe("m");
    await expect(out(operator, j, { goodQty: 1, uom: "ea" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("with stages defined, a stage is required and it must be in progress", async () => {
    await expect(out(operator, jobId, { goodQty: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(out(operator, jobId, { jobStageId: stageIds[1], goodQty: 1 })).rejects.toThrow(/not started/);
    await expect(out(operator, jobId, { jobStageId: uid(), goodQty: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a job without stages records output against the job; a stage id is refused", async () => {
    const { jobId: j } = await released(10, null);
    const r = await out(operator, j, { goodQty: 4 });
    expect(r.entry.jobStageId).toBeNull();
    expect(((await getJob(owner, j)) as any).status).toBe("in_progress"); // first activity starts the job
    await expect(out(operator, j, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("only roles with output:record can record; readers can read", async () => {
    await expect(out(viewer, jobId, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(out(finance, jobId, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listOutput(viewer, jobId)).entries.length).toBeGreaterThan(0);
  });

  it("totals: yield and over-plan are reported, and over-run is informational, not blocked", async () => {
    const { jobId: j, stageIds: s } = await released(10, [{ name: "Only" }]);
    await act(operator, j, s[0], "start");
    await out(operator, j, { jobStageId: s[0], goodQty: 8, scrapQty: 2, reason: "damaged" });
    await out(operator, j, { jobStageId: s[0], goodQty: 4 }); // 12 good > 10 planned
    const l = await listOutput(operator, j);
    // yield is withheld until the whole routing is complete (here the only stage is still running)
    expect(l.totals).toMatchObject({ grossGood: "12", effectiveGood: "12", scrap: "2", processed: "14", yieldPercent: null });
    await act(operator, j, s[0], "complete");
    expect((await listOutput(operator, j)).totals.yieldPercent).toBe("85.7");
    expect(l.exceedsPlan).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("output: idempotency and concurrency", () => {
  let jobId: string;
  let stageIds: string[];
  beforeAll(async () => {
    ({ jobId, stageIds } = await released());
    await act(operator, jobId, stageIds[0], "start");
  });

  it("a retry with the same clientRequestId replays; different data under it conflicts", async () => {
    const id = uid();
    const a = await recordOutput(operator, jobId, { clientRequestId: id, jobStageId: stageIds[0], goodQty: 3 });
    const b = await recordOutput(operator, jobId, { clientRequestId: id, jobStageId: stageIds[0], goodQty: 3 });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    await expect(recordOutput(operator, jobId, { clientRequestId: id, jobStageId: stageIds[0], goodQty: 4 })).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.productionOutput.count({ where: { orgId: org.organizationId, clientRequestId: id } })).toBe(1);
  });

  it("six concurrent identical submissions create one entry", async () => {
    const id = uid();
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => recordOutput(operator, jobId, { clientRequestId: id, jobStageId: stageIds[0], goodQty: 2 })));
    expect(rs.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.productionOutput.count({ where: { orgId: org.organizationId, clientRequestId: id } })).toBe(1);
  });

  it("cumulative rules hold under concurrency: only as many units return from rework as were sent", async () => {
    await out(operator, jobId, { jobStageId: stageIds[0], reworkQty: 5, reason: "paint_defect" });
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => out(operator, jobId, { jobStageId: stageIds[0], goodQty: 1, reworkGoodQty: 1 })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    for (const r of rs.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
    const totals = (await listOutput(operator, jobId)).byStage[stageIds[0]];
    expect(totals.reworkOpen).toBe("0");
  });

  it("entries are append-only at the database level", async () => {
    const row = await prisma.productionOutput.findFirst({ where: { jobId } });
    await expect(prisma.productionOutput.update({ where: { id: row!.id }, data: { goodQty: 999 } })).rejects.toBeTruthy();
    await expect(prisma.productionOutput.delete({ where: { id: row!.id } })).rejects.toBeTruthy();
    // negative or operator-set reclassification is refused by CHECK constraints
    await expect(prisma.productionOutput.create({ data: { orgId: org.organizationId, jobId, jobStageId: stageIds[0], goodQty: -1, uom: "ea" } })).rejects.toBeTruthy();
    await expect(prisma.productionOutput.create({ data: { orgId: org.organizationId, jobId, jobStageId: stageIds[0], goodQty: 1, scrapQty: 1, reason: "damaged", reclassifiedFromGoodQty: 1, uom: "ea" } })).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("output: voiding a mistaken entry", () => {
  it("is a reasoned, manager-only, audited reversal; the entry itself is never edited", async () => {
    const { jobId, stageIds } = await released(20, [{ name: "A" }, { name: "B" }]);
    await act(operator, jobId, stageIds[0], "start");
    const wrong = (await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 100 })).entry; // typo for 10
    await expect(voidOutput(operator, jobId, wrong.id, { reason: "typo in quantity" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(voidOutput(mgr, jobId, wrong.id, { reason: "x" })).rejects.toBeInstanceOf(ValidationError);
    await voidOutput(mgr, jobId, wrong.id, { reason: "typo in quantity" });
    await expect(voidOutput(mgr, jobId, wrong.id, { reason: "typo in quantity" })).rejects.toBeInstanceOf(ConflictError);
    const l = await listOutput(mgr, jobId);
    expect(l.totals.effectiveGood).toBe("0");
    expect(l.entries.find((e) => e.id === wrong.id)?.voided).toMatchObject({ reason: "typo in quantity" });
    expect(await prisma.productionOutput.findUnique({ where: { id: wrong.id } })).toMatchObject({ goodQty: expect.anything() });
    expect(await prisma.auditLog.count({ where: { entityType: "production_output", entityId: wrong.id, action: "update" } })).toBe(1);
    // the void row can't be altered or removed
    const v = await prisma.productionOutputVoid.findFirst({ where: { outputId: wrong.id } });
    await expect(prisma.productionOutputVoid.delete({ where: { id: v!.id } })).rejects.toBeTruthy();
  });

  it("is refused when it would leave the records inconsistent, or once the stage is complete", async () => {
    const { jobId, stageIds } = await released(20, [{ name: "A" }]);
    await act(operator, jobId, stageIds[0], "start");
    const sent = (await out(operator, jobId, { jobStageId: stageIds[0], reworkQty: 3, reason: "damaged" })).entry;
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 3, reworkGoodQty: 3 });
    await expect(voidOutput(mgr, jobId, sent.id, { reason: "wrong entry" })).rejects.toThrow(/inconsistent/);
    const good = (await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 5 })).entry;
    await act(operator, jobId, stageIds[0], "complete");
    await expect(voidOutput(mgr, jobId, good.id, { reason: "wrong entry" })).rejects.toThrow(/completed stage/);
  });
});

// ---------------------------------------------------------------------------
describe("quality control", () => {
  let jobId: string;
  let stageIds: string[];
  beforeAll(async () => {
    ({ jobId, stageIds } = await released(20, [{ name: "Weld", requiresInspection: true }, { name: "Paint" }]));
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 20 });
  });

  it("validates inspections: quantities, defect category, and units actually available", async () => {
    for (const bad of [{ inspectedQty: 0 }, { inspectedQty: -2 }, { inspectedQty: 5, rejectedQty: 6, rejectReason: "damaged" }, { inspectedQty: 5, rejectedQty: 1 }, { inspectedQty: 5, rejectedQty: -1 }]) {
      await expect(insp(operator, jobId, { jobStageId: stageIds[0], ...bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 21 })).rejects.toThrow(/Only 20 reported-good/);
    await expect(insp(operator, jobId, { inspectedQty: 5 })).rejects.toBeInstanceOf(ValidationError); // stage required
    await expect(insp(operator, jobId, { jobStageId: stageIds[1], inspectedQty: 1 })).rejects.toBeInstanceOf(ConflictError); // stage not started
  });

  it("readers can see inspections but only quality:record roles can record", async () => {
    await expect(insp(viewer, jobId, { jobStageId: stageIds[0], inspectedQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(insp(finance, jobId, { jobStageId: stageIds[0], inspectedQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listInspections(viewer, jobId)).resolves.toBeTruthy();
  });

  let failed: any;
  it("records a failed inspection with inspector, time and defect category; it is never discarded", async () => {
    const r = await insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 10, rejectedQty: 4, rejectReason: "wrong_dimensions", notes: "Bracket 2mm short", evidenceRef: "photo-17" });
    failed = r.inspection;
    expect(failed).toMatchObject({ outcome: "fail", inspectedQty: "10", acceptedQty: "6", rejectedQty: "4", defectCategory: "wrong_dimensions", inspectorUserId: operator.userId, disposition: "open", openRejectedQty: "4", uom: "ea" });
    expect(failed.inspectedAt).toBeTruthy();
    // immutable
    await expect(prisma.qualityRecord.update({ where: { id: failed.id }, data: { outcome: "pass", rejectedQty: 0, acceptedQty: 10 } })).rejects.toBeTruthy();
    await expect(prisma.qualityRecord.delete({ where: { id: failed.id } })).rejects.toBeTruthy();
  });

  it("an inspector cannot approve a failed result: dispositions need quality:approve", async () => {
    for (const s of [operator, viewer, finance]) {
      await expect(disp(s, jobId, failed.id, { kind: "use_as_is", qty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("while rejects are undecided the stage can't complete and the job isn't ready", async () => {
    await insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 10 }); // the rest pass
    await expect(act(operator, jobId, stageIds[0], "complete")).rejects.toThrow(/4 rejected unit\(s\) .* still need a disposition/);
    const r = await getJobReadiness(viewer, jobId);
    expect(r.canComplete).toBe(false);
    expect(r.jobBlockers.join(" ")).toMatch(/rejected unit/);
  });

  it("dispositions: scrap and rework move units in the output ledger; use-as-is is a recorded concession", async () => {
    const before = (await listOutput(mgr, jobId)).byStage[stageIds[0]];
    expect(before).toMatchObject({ grossGood: "20", effectiveGood: "20", scrap: "0" });

    const scrap = await disp(mgr, jobId, failed.id, { kind: "scrap", qty: 1, reason: "Beyond repair" });
    const rework = await disp(mgr, jobId, failed.id, { kind: "rework", qty: 2, reason: "Re-machine bracket" });
    const asIs = await disp(mgr, jobId, failed.id, { kind: "use_as_is", qty: 1, reason: "Customer concession ref 88" });
    expect(scrap.replayed || rework.replayed || asIs.replayed).toBe(false);

    const after = (await listOutput(mgr, jobId)).byStage[stageIds[0]];
    expect(after).toMatchObject({ grossGood: "20", effectiveGood: "17", scrap: "1", rework: "2", reworkOpen: "2", reclassified: "3" });
    const sys = await prisma.productionOutput.findMany({ where: { jobId, source: "quality_disposition" } });
    expect(sys).toHaveLength(2); // use_as_is changes no quantities
    expect(sys.every((r) => r.inspectionId === failed.id && r.reason === "wrong_dimensions")).toBe(true);
    expect((await listInspections(mgr, jobId)).inspections.find((i) => i.id === failed.id)?.disposition).toBe("resolved");
    // each decision is audited with the approver and reason
    const a = await prisma.auditLog.findFirst({ where: { entityType: "quality_disposition", entityId: (scrap as any).disposition.id } });
    expect(a).toMatchObject({ actorUserId: mgr.userId, reason: "Beyond repair" });
  });

  it("cannot dispose of more than was rejected (service and database)", async () => {
    await expect(disp(mgr, jobId, failed.id, { kind: "scrap", qty: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      prisma.qualityDisposition.create({ data: { orgId: org.organizationId, jobId, inspectionId: failed.id, kind: "scrap", qty: 1, reason: "Direct insert", decidedBy: mgr.userId } }),
    ).rejects.toBeTruthy();
  });

  it("the rework loop closes: units return via output, then the stage can complete", async () => {
    await expect(act(operator, jobId, stageIds[0], "complete")).rejects.toThrow(/2 unit\(s\) are still in rework/);
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 2, reworkGoodQty: 2 });
    // the 2 reworked units are new good units and must themselves be inspected
    await expect(act(operator, jobId, stageIds[0], "complete")).rejects.toThrow(/2 good unit\(s\) .* have not been inspected/);
    await insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 2 });
    expect((await act(operator, jobId, stageIds[0], "complete")).status).toBe("completed");
  });
});

describe("quality: disposition idempotency", () => {
  it("a retried disposition replays instead of double-moving units; a different decision under the same id conflicts", async () => {
    const { jobId, stageIds } = await released(20, [{ name: "S" }]);
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 10 });
    const i = (await insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 10, rejectedQty: 5, rejectReason: "damaged" })).inspection;
    const id = uid();
    const a = await recordDisposition(mgr, jobId, i.id, { clientRequestId: id, kind: "scrap", qty: 2, reason: "Beyond repair" });
    const b = await recordDisposition(mgr, jobId, i.id, { clientRequestId: id, kind: "scrap", qty: 2, reason: "Beyond repair" });
    expect(b.replayed).toBe(true);
    await expect(recordDisposition(mgr, jobId, i.id, { clientRequestId: id, kind: "rework", qty: 2, reason: "Beyond repair" })).rejects.toBeInstanceOf(ConflictError);
    expect((await listOutput(mgr, jobId)).totals.scrap).toBe("2");
    expect(a.replayed).toBe(false);
    // concurrent decisions can't exceed the 5 rejected units
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => recordDisposition(mgr, jobId, i.id, { clientRequestId: uid(), kind: "scrap", qty: 1, reason: "Beyond repair" })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(3); // 2 already + 3 more = 5
    const row = await prisma.qualityDisposition.aggregate({ where: { inspectionId: i.id }, _sum: { qty: true } });
    expect(String(row._sum.qty)).toBe("5");
  });
});

// ---------------------------------------------------------------------------
describe("job completion and the cost snapshot", () => {
  async function runToEnd() {
    const { jobId, stageIds } = await released(10, [{ name: "Make" }, { name: "Check", requiresInspection: true }]);
    await issueMaterialToJob(owner, jobId, { clientRequestId: uid(), materialItemId: product.materialItems[0].id, warehouseId: wh, quantity: 25 }); // 25 kg @ 2 = 50
    await recordLabour(operator, jobId, { clientRequestId: uid(), hours: 5, rate: 10, rateCurrency: "USD" }); // 50
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 8, scrapQty: 2, reason: "damaged" });
    await act(operator, jobId, stageIds[0], "complete");
    return { jobId, stageIds };
  }

  it("a job with stages cannot be completed until every stage is, and says what is outstanding", async () => {
    const { jobId, stageIds } = await runToEnd();
    await expect(completeJob(mgr, jobId)).rejects.toThrow(/Stage 2 "Check" is not completed/);
    expect((await getJobReadiness(mgr, jobId)).canComplete).toBe(false);
    await act(operator, jobId, stageIds[1], "start");
    await out(operator, jobId, { jobStageId: stageIds[1], goodQty: 8 });
    await insp(operator, jobId, { jobStageId: stageIds[1], inspectedQty: 8 });
    await act(operator, jobId, stageIds[1], "complete");
    expect((await getJobReadiness(mgr, jobId)).canComplete).toBe(true);
    await expect(completeJob(mgr, jobId)).resolves.toBeTruthy();
  });

  it("jobs that don't use the shop-floor module are unaffected", async () => {
    const j = await newJob(5);
    await transitionJob(owner, j, { status: "released" });
    await issueMaterialToJob(owner, j, { clientRequestId: uid(), materialItemId: product.materialItems[0].id, warehouseId: wh, quantity: 1 });
    expect((await getJobReadiness(mgr, j)).canComplete).toBe(true);
    await expect(completeJob(mgr, j)).resolves.toBeTruthy();
  });

  it("after completion nothing can be added or changed, by the service or by direct writes", async () => {
    const { jobId, stageIds } = await runToEnd();
    await act(operator, jobId, stageIds[1], "start");
    await out(operator, jobId, { jobStageId: stageIds[1], goodQty: 8 });
    await insp(operator, jobId, { jobStageId: stageIds[1], inspectedQty: 8 });
    await act(operator, jobId, stageIds[1], "complete");
    await completeJob(mgr, jobId);

    await expect(out(operator, jobId, { jobStageId: stageIds[1], goodQty: 1 })).rejects.toBeInstanceOf(ConflictError);
    await expect(insp(operator, jobId, { jobStageId: stageIds[1], inspectedQty: 1 })).rejects.toBeInstanceOf(ConflictError);
    await expect(defineStages(mgr, jobId, { stages: [{ name: "late" }] })).rejects.toBeInstanceOf(ConflictError);
    await expect(act(operator, jobId, stageIds[0], "block", { reason: "too late now" })).rejects.toBeInstanceOf(ConflictError);
    await expect(prisma.productionOutput.create({ data: { orgId: org.organizationId, jobId, jobStageId: stageIds[1], goodQty: 1, uom: "ea" } })).rejects.toBeTruthy();
    await expect(prisma.qualityRecord.create({ data: { orgId: org.organizationId, jobId, producedQty: 1, acceptedQty: 1, rejectedQty: 0, outcome: "pass", inspectorUserId: mgr.userId } })).rejects.toBeTruthy();
    await expect(prisma.productionJobStage.create({ data: { orgId: org.organizationId, jobId, stageName: "late", sequence: 9 } })).rejects.toBeTruthy();
  });

  it("the snapshot freezes the shop-floor summary (quantities only) and later activity can't change it", async () => {
    const { jobId, stageIds } = await runToEnd();
    await act(operator, jobId, stageIds[1], "start");
    await out(operator, jobId, { jobStageId: stageIds[1], goodQty: 8 });
    await insp(operator, jobId, { jobStageId: stageIds[1], inspectedQty: 8 });
    await act(operator, jobId, stageIds[1], "complete");
    await completeJob(mgr, jobId);
    const snap = await prisma.jobCostActual.findUnique({ where: { jobId } });
    const sf = (snap!.evidence as any).shopfloor;
    expect(sf.stages).toEqual({ total: 2, completed: 2 });
    // two stages: good output is what left the LAST stage (8), not 8 + 8
    expect(sf.output).toMatchObject({ grossGood: "8", effectiveGood: "8", scrap: "2", processed: "10", yieldPercent: "80" });
    expect(sf.inspections).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(JSON.stringify(sf)).not.toMatch(/cost|price|amount/i); // quantities only
    await expect(prisma.jobCostActual.update({ where: { jobId }, data: { evidence: {} } })).rejects.toBeTruthy();
  });

  it("a posting racing completion is either in the frozen summary or refused, never lost", async () => {
    for (let i = 0; i < 6; i++) {
      const { jobId, stageIds } = await released(10, [{ name: "Only" }]);
      await issueMaterialToJob(owner, jobId, { clientRequestId: uid(), materialItemId: product.materialItems[0].id, warehouseId: wh, quantity: 1 });
      await recordLabour(operator, jobId, { clientRequestId: uid(), hours: 1, rate: 1, rateCurrency: "USD" });
      await act(operator, jobId, stageIds[0], "start");
      await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 5 });
      const [o, c] = await Promise.allSettled([out(operator, jobId, { jobStageId: stageIds[0], goodQty: 3 }), act(operator, jobId, stageIds[0], "complete")]);
      expect(c.status).toBe("fulfilled");
      const job = await completeJob(mgr, jobId).catch((e) => e);
      expect(job).not.toBeInstanceOf(Error);
      const snap = await prisma.jobCostActual.findUnique({ where: { jobId } });
      const frozen = (snap!.evidence as any).shopfloor.output.grossGood;
      const live = (await prisma.productionOutput.aggregate({ where: { jobId, void: null }, _sum: { goodQty: true } }))._sum.goodQty;
      expect(frozen).toBe(String(live));
      expect(frozen).toBe(o.status === "fulfilled" ? "8" : "5");
    }
  }, 90_000);

  it("a failed completion (blockers) changes nothing and takes no snapshot", async () => {
    const { jobId } = await runToEnd();
    await expect(completeJob(mgr, jobId)).rejects.toBeInstanceOf(ConflictError);
    expect(((await getJob(owner, jobId)) as any).status).toBe("in_progress");
    expect(await prisma.jobCostActual.count({ where: { jobId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("costing integration (no new money, no double counting)", () => {
  let jobId: string;
  beforeAll(async () => {
    const r = await released(10, [{ name: "Make" }]);
    jobId = r.jobId;
    await issueMaterialToJob(owner, jobId, { clientRequestId: uid(), materialItemId: product.materialItems[0].id, warehouseId: wh, quantity: 25 }); // USD 50
    await recordLabour(operator, jobId, { clientRequestId: uid(), hours: 5, rate: 10, rateCurrency: "USD" }); // USD 50
    await act(operator, jobId, r.stageIds[0], "start");
    await out(operator, jobId, { jobStageId: r.stageIds[0], goodQty: 8, scrapQty: 2, reason: "damaged" });
  });

  it("recording scrap/output posts no cost: actual cost is still just issued material and labour", async () => {
    const c = (await getJobCost(finance, jobId)) as any;
    expect(c.lines[0].actual).toMatchObject({ material: "50", labour: "50" });
    expect(await prisma.stockMovement.count({ where: { referenceId: jobId } })).toBe(1); // the one material issue
    expect(c.output).toMatchObject({ effectiveGood: "8", scrap: "2", processed: "10", yieldPercent: null }); // live: yield waits for completion
  });

  it("cost per good unit is withheld on a live job and given (calculated) once final", async () => {
    const live = (await getJobCost(finance, jobId)) as any;
    expect(live.output.costPerGoodUnit).toEqual({ available: false, reason: "job_not_completed" });
    const stage = (await listStages(mgr, jobId)).stages[0];
    await act(operator, jobId, stage.id, "complete");
    await completeJob(mgr, jobId);
    const c = (await getJobCost(finance, jobId)) as any;
    // (50 + 50) / 8 good units = 12.5 per good unit: the 2 scrapped units' cost is inside it
    expect(c.output.yieldPercent).toBe("80");
    expect(c.output.costPerGoodUnit).toEqual({ available: true, currency: "USD", amount: "12.5", basis: "calculated", excludesOverhead: true, includesScrapAndRework: true });
  });

  it("a post-completion correction goes through the Phase 2 adjustment, which moves the unit cost", async () => {
    await recordCostAdjustment(finance, jobId, { clientRequestId: uid(), currency: "USD", component: "labour", amount: 20, reason: "Late rework timesheet" });
    const c = (await getJobCost(finance, jobId)) as any;
    expect(c.output.costPerGoodUnit.amount).toBe("15"); // (50 + 70) / 8
    expect(c.lines[0].actual.labour).toBe("50"); // the frozen snapshot itself is unchanged
  });

  it("quantity records are not money: roles without cost:read never reach the cost view", async () => {
    await expect(getJobCost(operator, jobId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getJobCost(mgr, jobId)).resolves.toBeTruthy(); // production manager holds cost:read
    await expect(getJobCost(viewer, jobId)).rejects.toBeInstanceOf(ForbiddenError);
    // but the shop-floor views themselves carry no cost fields
    expect(JSON.stringify(await listOutput(viewer, jobId))).not.toMatch(/cost|price|rate/i);
    expect(JSON.stringify(await listStages(operator, jobId))).not.toMatch(/\bcost|price/i);
    expect(JSON.stringify(await listInspections(viewer, jobId))).not.toMatch(/cost|price/i);
  });

  it("no cost per good unit when nothing good was produced", async () => {
    const r = await released(10, [{ name: "Make" }]);
    await issueMaterialToJob(owner, r.jobId, { clientRequestId: uid(), materialItemId: product.materialItems[0].id, warehouseId: wh, quantity: 4 });
    expect(((await getJobCost(finance, r.jobId)) as any).output.costPerGoodUnit).toEqual({ available: false, reason: "no_good_output" });
  });
});

// ---------------------------------------------------------------------------
describe("tenant and branch isolation", () => {
  let jobId: string;
  let stageIds: string[];
  let outputId: string;
  let inspectionId: string;
  beforeAll(async () => {
    ({ jobId, stageIds } = await released());
    await act(operator, jobId, stageIds[0], "start");
    outputId = (await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 10 })).entry.id;
    inspectionId = (await insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 5, rejectedQty: 2, rejectReason: "damaged" })).inspection.id;
  });

  it("another organization sees nothing and can change nothing", async () => {
    await expect(listStages(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listOutput(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listInspections(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getJobReadiness(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(defineStages(ownerB, jobId, { stages: [{ name: "x" }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(act(ownerB, jobId, stageIds[0], "block", { reason: "hostile" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(out(ownerB, jobId, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(voidOutput(ownerB, jobId, outputId, { reason: "hostile void" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(insp(ownerB, jobId, { jobStageId: stageIds[0], inspectedQty: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(disp(ownerB, jobId, inspectionId, { kind: "scrap", qty: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a user without access to the job's branch is treated the same way", async () => {
    await expect(listStages(otherBranch, jobId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(out(otherBranch, jobId, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(act(otherBranch, jobId, stageIds[0], "complete")).rejects.toBeInstanceOf(NotFoundError);
    await expect(disp(otherBranch, jobId, inspectionId, { kind: "scrap", qty: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("ids can't be used across jobs: a stage, output or inspection of job A is unknown to job B", async () => {
    const other = await released();
    await expect(out(operator, other.jobId, { jobStageId: stageIds[0], goodQty: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(act(operator, other.jobId, stageIds[0], "start")).rejects.toBeInstanceOf(NotFoundError);
    await expect(voidOutput(mgr, other.jobId, outputId, { reason: "cross-job void" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(disp(mgr, other.jobId, inspectionId, { kind: "scrap", qty: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the audit log for shop-floor events stays within its organization", async () => {
    expect(await prisma.auditLog.count({ where: { orgId: orgB.organizationId, entityType: { in: ["production_output", "quality_record", "production_job_stage"] } } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("multi-stage accounting: the same units pass through every stage", () => {
  it("a later stage can't account for more units than left the earlier one", async () => {
    const { jobId, stageIds } = await released(20, [{ name: "A" }, { name: "B" }]);
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 8, scrapQty: 2, reason: "damaged" });
    await act(operator, jobId, stageIds[0], "complete");
    await act(operator, jobId, stageIds[1], "start");
    await expect(out(operator, jobId, { jobStageId: stageIds[1], goodQty: 9 })).rejects.toThrow(/only 8 left "A"/);
    await expect(out(operator, jobId, { jobStageId: stageIds[1], goodQty: 6, scrapQty: 3, reason: "damaged" })).rejects.toThrow(/account for 9/);
    await expect(out(operator, jobId, { jobStageId: stageIds[1], goodQty: 6, scrapQty: 2, reason: "damaged" })).resolves.toBeTruthy();
    // the earlier stage's output can't be voided from under the later one
    const first = (await listOutput(mgr, jobId)).entries.find((e) => e.jobStageId === stageIds[0])!;
    await expect(voidOutput(mgr, jobId, first.id, { reason: "wrong entry" })).rejects.toBeInstanceOf(ConflictError); // stage 1 is completed
  });

  it("job-level good output is the last stage's, scrap sums across stages, and yield waits for completion", async () => {
    const { jobId, stageIds } = await released(10, [{ name: "A" }, { name: "B" }]);
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 9, scrapQty: 1, reason: "damaged" });
    await act(operator, jobId, stageIds[0], "complete");
    await act(operator, jobId, stageIds[1], "start");
    await out(operator, jobId, { jobStageId: stageIds[1], goodQty: 7, scrapQty: 2, reason: "paint_defect" });
    const live = (await listOutput(mgr, jobId)).totals;
    expect(live).toMatchObject({ effectiveGood: "7", scrap: "3", processed: "10", yieldPercent: null }); // not 16 good; no live yield
    await act(operator, jobId, stageIds[1], "complete");
    expect((await listOutput(mgr, jobId)).totals).toMatchObject({ effectiveGood: "7", yieldPercent: "70" });
  });

  it("cost per good unit divides by units that actually finished, so scrap at any stage raises it", async () => {
    const { jobId, stageIds } = await released(10, [{ name: "A" }, { name: "B" }]);
    await issueMaterialToJob(owner, jobId, { clientRequestId: uid(), materialItemId: product.materialItems[0].id, warehouseId: wh, quantity: 20 }); // USD 40
    await recordLabour(operator, jobId, { clientRequestId: uid(), hours: 4, rate: 10, rateCurrency: "USD" }); // USD 40
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 9, scrapQty: 1, reason: "damaged" });
    await act(operator, jobId, stageIds[0], "complete");
    await act(operator, jobId, stageIds[1], "start");
    await out(operator, jobId, { jobStageId: stageIds[1], goodQty: 8, scrapQty: 1, reason: "damaged" });
    await act(operator, jobId, stageIds[1], "complete");
    await completeJob(mgr, jobId);
    const c = (await getJobCost(finance, jobId)) as any;
    expect(c.output).toMatchObject({ effectiveGood: "8", scrap: "2" });
    expect(c.output.costPerGoodUnit).toMatchObject({ available: true, amount: "10" }); // 80 / 8, not 80 / 17
  });
});
