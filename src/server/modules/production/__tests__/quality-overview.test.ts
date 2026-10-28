/* eslint-disable @typescript-eslint/no-explicit-any */
// Cross-job quality views, the operator workspace list, and one journey through every module:
// customer -> order -> release -> receive/issue -> stages -> output -> inspection -> decision ->
// completion -> job-cost and profitability reports.
import { describe, expect, it, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { createCustomer } from "../../customers/customer-service";
import { createSalesOrder, confirmSalesOrder, getSalesOrder } from "../../sales/sales-order-service";
import { createJob, transitionJob, completeJob, listJobs } from "../job-service";
import { createWarehouse } from "../../inventory/warehouse-service";
import { receiveStock } from "../../inventory/stock-service";
import { issueMaterialToJob } from "../../inventory/material-issue-service";
import { recordLabour } from "../labour-service";
import { defineStages, transitionStage } from "../stage-service";
import { recordOutput } from "../output-service";
import { recordDisposition, recordInspection } from "../quality-service";
import { getInspectionById, listBlockedJobs, listInspectionsAcrossJobs } from "../quality-overview";
import { listWorkspaceJobs } from "../shopfloor-workspace";
import { getJobCost, getProfitabilityReport, listJobCosts } from "../../costing/cost-service";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

const uid = () => randomUUID();
let org: TestOrg, orgB: TestOrg;
let owner: AuthenticatedSession, ownerB: AuthenticatedSession, mgr: AuthenticatedSession, operator: AuthenticatedSession, otherBranchMgr: AuthenticatedSession, viewer: AuthenticatedSession;
let wh: string;
let product: Awaited<ReturnType<typeof productWithActiveBom>>;
let secondBranch: string;

beforeAll(async () => {
  org = await createTestOrg("qo-A");
  orgB = await createTestOrg("qo-B");
  owner = await ownerSession(org);
  ownerB = await ownerSession(orgB);
  secondBranch = (await createBranch(owner, { name: "Second" })).id;
  wh = (await createWarehouse(owner, { branchId: org.branchId, name: "Main" })).id;
  mgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "qo-mgr", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "qo-op", [org.branchId]);
  viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "qo-vw", [org.branchId]);
  otherBranchMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "qo-ob", [secondBranch]);
  product = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 2 }]);
  await receiveStock(owner, { clientRequestId: uid(), warehouseId: wh, itemId: product.materialItems[0].id, quantity: 10_000, unitCost: 2, currency: "USD" });
}, 300_000);

async function releasedJob(plannedQty = 10, stages = [{ name: "Make" }, { name: "Check", requiresInspection: true }]) {
  const id = ((await createJob(owner, { branchId: org.branchId, productItemId: product.product.id, plannedQty })) as any).id as string;
  const stageIds = (await defineStages(mgr, id, { stages })).stages.map((s) => s.id);
  await transitionJob(owner, id, { status: "released" });
  return { jobId: id, stageIds };
}
const act = (s: AuthenticatedSession, jobId: string, stageId: string, action: string) => transitionStage(s, jobId, stageId, { action });
const out = (s: AuthenticatedSession, jobId: string, body: Record<string, unknown>) => recordOutput(s, jobId, { clientRequestId: uid(), ...body });
const insp = (s: AuthenticatedSession, jobId: string, body: Record<string, unknown>) => recordInspection(s, jobId, { clientRequestId: uid(), ...body });

describe("quality overview and workspace", () => {
  it("lists rejected inspections across jobs, flags the job as blocked, and clears once decided", async () => {
    const { jobId, stageIds } = await releasedJob();
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 10 });
    const failed = (await insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 10, rejectedQty: 3, rejectReason: "damaged" })).inspection;

    const open = await listInspectionsAcrossJobs(viewer, { openOnly: true });
    expect(open.rows.map((r) => r.id)).toContain(failed.id);
    expect((await listInspectionsAcrossJobs(viewer, { outcome: "pass" })).rows.some((r) => r.id === failed.id)).toBe(false);
    const blocked = await listBlockedJobs(viewer);
    const mine = blocked.jobs.find((j) => j.jobId === jobId)!;
    expect(mine.openRejectedUnits).toBe("3");
    expect(mine.blockers.join(" ")).toMatch(/rejected unit|stage/i);

    // The same block the server applies on completion: the UI list can't disagree with it.
    await expect(completeJob(mgr, jobId)).rejects.toThrow();

    await recordDisposition(mgr, jobId, failed.id, { clientRequestId: uid(), kind: "scrap", qty: 3, reason: "Beyond repair" });
    expect((await listInspectionsAcrossJobs(viewer, { openOnly: true })).rows.map((r) => r.id)).not.toContain(failed.id);
    const detail = await getInspectionById(viewer, failed.id);
    expect(detail.disposition).toBe("resolved");
    expect(detail.dispositions).toHaveLength(1);
  });

  it("is branch- and org-scoped, and capability-gated", async () => {
    const { jobId, stageIds } = await releasedJob();
    await act(operator, jobId, stageIds[0], "start");
    await out(operator, jobId, { jobStageId: stageIds[0], goodQty: 5 });
    const r = (await insp(operator, jobId, { jobStageId: stageIds[0], inspectedQty: 5, rejectedQty: 1, rejectReason: "damaged" })).inspection;

    // A manager of ANOTHER branch, and another organization, see nothing and get "not found".
    await expect(getInspectionById(otherBranchMgr, r.id)).rejects.toThrow(/not found/i);
    await expect(getInspectionById(ownerB, r.id)).rejects.toThrow(/not found/i);
    expect((await listInspectionsAcrossJobs(otherBranchMgr)).rows.map((x) => x.id)).not.toContain(r.id);
    expect((await listInspectionsAcrossJobs(ownerB)).total).toBe(0);
    expect((await listBlockedJobs(otherBranchMgr)).jobs.some((j) => j.jobId === jobId)).toBe(false);
    await expect(listInspectionsAcrossJobs(otherBranchMgr, { branchId: org.branchId })).rejects.toThrow(/access to this branch/);
    await expect(getInspectionById(owner, "nope")).rejects.toThrow(/not found/i);
  });

  it("operator workspace: scoped, shows assigned work first, and carries no customer, quote or cost data", async () => {
    const mine = await releasedJob();
    await transitionStage(mgr, mine.jobId, mine.stageIds[0], { action: "assign", operatorUserId: operator.userId } as any).catch(() => undefined);
    const jobs = await listWorkspaceJobs(operator);
    expect(jobs.some((j) => j.id === mine.jobId)).toBe(true);
    expect(JSON.stringify(jobs)).not.toMatch(/customer|quot|cost|price|revenue/i);
    expect(jobs.every((j) => ["released", "in_progress", "on_hold"].includes(j.status))).toBe(true);

    const none = await listWorkspaceJobs(otherBranchMgr, { branchId: org.branchId });
    expect(none).toEqual([]); // a branch they can't reach shows nothing
    expect(await listWorkspaceJobs(ownerB)).toEqual([]);
    await expect(listWorkspaceJobs(operator, { branchId: "nope" })).rejects.toThrow(/Invalid branchId/);
  });

  it("job list can be filtered by customer, but only by roles that may read customers", async () => {
    const c = await createCustomer(owner, { name: "Filter Co" });
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: c.id, currency: "USD", lines: [{ itemId: product.product.id, quantity: 3, unitPrice: 4 }] });
    await confirmSalesOrder(owner, o.id);
    const j = (await createJob(owner, { branchId: org.branchId, productItemId: product.product.id, plannedQty: 3, salesOrderLineId: o.lines[0].id })) as any;
    expect((await listJobs(owner, { customerId: c.id })).map((x: any) => x.id)).toEqual([j.id]);
    await expect(listJobs(operator, { customerId: c.id })).rejects.toThrow(/does not have/);
    await expect(listJobs(owner, { customerId: "x" })).rejects.toThrow(/Invalid customerId/);
  });
});

describe("journey: order to reported cost", () => {
  it("customer -> order -> release -> produce -> inspect -> decide -> complete -> reports", async () => {
    const customer = await createCustomer(owner, { name: "Journey Co" });
    const order = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [{ itemId: product.product.id, quantity: 10, unitPrice: 20 }] });
    await confirmSalesOrder(owner, order.id);

    const job = (await createJob(owner, { branchId: org.branchId, productItemId: product.product.id, plannedQty: 10, salesOrderLineId: order.lines[0].id })) as any;
    const stageIds = (await defineStages(mgr, job.id, { stages: [{ name: "Make" }, { name: "Check", requiresInspection: true }] })).stages.map((s) => s.id);
    await transitionJob(owner, job.id, { status: "released" });

    await issueMaterialToJob(owner, job.id, { clientRequestId: uid(), materialItemId: product.materialItems[0].id, warehouseId: wh, quantity: 25 }); // 25kg @ 2 = 50
    await recordLabour(operator, job.id, { clientRequestId: uid(), hours: 5, rate: 10, rateCurrency: "USD" }); // 50

    await act(operator, job.id, stageIds[0], "start");
    await out(operator, job.id, { jobStageId: stageIds[0], goodQty: 10 });
    await act(operator, job.id, stageIds[0], "complete");
    await act(operator, job.id, stageIds[1], "start");
    await out(operator, job.id, { jobStageId: stageIds[1], goodQty: 10 });
    const failed = (await insp(operator, job.id, { jobStageId: stageIds[1], inspectedQty: 10, rejectedQty: 2, rejectReason: "damaged" })).inspection;

    // Unresolved rejects block completion; the quality screens say so.
    await expect(completeJob(mgr, job.id)).rejects.toThrow();
    expect((await listBlockedJobs(mgr)).jobs.some((j) => j.jobId === job.id)).toBe(true);

    await recordDisposition(mgr, job.id, failed.id, { clientRequestId: uid(), kind: "use_as_is", qty: 2, reason: "Customer concession" });
    await insp(operator, job.id, { jobStageId: stageIds[1], inspectedQty: 8 }).catch(() => undefined);
    await act(operator, job.id, stageIds[1], "complete");
    await completeJob(mgr, job.id);

    // Order still shows its linked job; the job's frozen cost feeds both reports.
    expect((await getSalesOrder(owner, order.id)).lines[0].productionJob?.jobNumber).toBe(job.jobNumber);
    const cost = (await getJobCost(owner, job.id)) as any;
    expect(cost.actualBasis).toBe("snapshot");
    const costs = await listJobCosts(owner, {});
    const row = costs.find((c: any) => c.jobId === job.id)!;
    expect(row.lines[0].actual.material).toBe("50");
    expect(row.lines[0].actual.labour).toBe("50");

    const report = (await getProfitabilityReport(owner, {})) as any;
    const p = report.rows.find((r: any) => r.jobId === job.id);
    expect(p.profit).toMatchObject({ available: true, currency: "USD", revenue: "200", actualCost: "100", grossProfit: "100" });
    // A viewer (no cost:read) can't read either report.
    await expect(listJobCosts(viewer, {})).rejects.toThrow(/does not have/);
    await expect(getProfitabilityReport(viewer, {})).rejects.toThrow(/does not have/);
  });
});
