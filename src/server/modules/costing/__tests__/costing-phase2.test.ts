/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { prisma } from "../../../shared/db";
import { createJob, transitionJob, completeJob } from "../../production/job-service";
import { recordLabour } from "../../production/labour-service";
import { createWarehouse } from "../../inventory/warehouse-service";
import { receiveStock } from "../../inventory/stock-service";
import { issueMaterialToJob } from "../../inventory/material-issue-service";
import { recordExchangeRate } from "../exchange-rate-service";
import { getJobCost, getProfitabilityReport } from "../cost-service";
import { recordCostAdjustment } from "../cost-adjustment-service";
import { computeActualCostLines } from "../actual-cost";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import { capabilitiesFor } from "../../../shared/authz";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";

let org: TestOrg;
let orgB: TestOrg;
let owner: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let finance: AuthenticatedSession;
let finance2: AuthenticatedSession; // other branch
let prodMgr: AuthenticatedSession;
let operator: AuthenticatedSession;
let wh: string;
let usdProduct: Awaited<ReturnType<typeof productWithActiveBom>>; // std 2 USD/kg, 2 kg per unit
let twoCcy: Awaited<ReturnType<typeof productWithActiveBom>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rec = (itemId: string, quantity: number, unitCost: number, currency: string) =>
  receiveStock(owner, { clientRequestId: randomUUID(), warehouseId: wh, itemId, quantity, unitCost, currency });
const issue = (jobId: string, materialItemId: string, quantity: number) =>
  issueMaterialToJob(owner, jobId, { clientRequestId: randomUUID(), materialItemId, warehouseId: wh, quantity });
const labour = (jobId: string, hours: number, rate: number, rateCurrency: string) =>
  recordLabour(prodMgr, jobId, { clientRequestId: randomUUID(), hours, rate, rateCurrency });
const newJob = async (p: typeof usdProduct, plannedQty: number, quote?: number) =>
  ((await createJob(owner, { branchId: org.branchId, productItemId: p.product.id, plannedQty, ...(quote ? { quotedAmount: quote, quotedCurrency: "USD" } : {}) })) as any).id as string;
const start = async (jobId: string) => {
  await transitionJob(owner, jobId, { status: "released" });
};

beforeAll(async () => {
  org = await createTestOrg("cost2A");
  orgB = await createTestOrg("cost2B");
  owner = await ownerSession(org);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(owner, { name: "Second" })).id;
  wh = (await createWarehouse(owner, { branchId: org.branchId, name: "Main store" })).id;
  finance = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "fm", [org.branchId]);
  finance2 = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "fm2", [branch2]);
  prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "pm", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "op", [org.branchId]);

  usdProduct = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 2 }]);
  twoCcy = await productWithActiveBom(owner, [
    { uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 2 },
    { uom: "ea", standardCost: 100, standardCostCurrency: "ZIG", bomQty: 1 },
  ]);
  await rec(usdProduct.materialItems[0].id, 10_000, 2, "USD");
  await rec(twoCcy.materialItems[0].id, 1_000, 2, "USD");
  await rec(twoCcy.materialItems[1].id, 1_000, 100, "ZIG");
}, 300_000);

// ---------------------------------------------------------------------------
describe("completeness, comparable variance and margin gating", () => {
  let openJob: string;
  let fullJob: string;
  let noLabourJob: string;

  it("an in-progress job: variance is not comparable and margin is withheld (to-date is progress, not variance)", async () => {
    openJob = await newJob(usdProduct, 10, 500);
    await start(openJob);
    await issue(openJob, usdProduct.materialItems[0].id, 8); // 8 of 20 expected, USD 16
    await labour(openJob, 2, 5, "USD");
    const c = (await getJobCost(finance, openJob)) as any;
    expect(c.actualBasis).toBe("live");
    expect(c.lines[0].variance).toMatchObject({ comparable: false, percent: null, reason: "job_in_progress" });
    expect(c.lines[0].variance.material).toBe("-24"); // legacy to-date amount unchanged
    expect(c.profit).toMatchObject({ available: false, reason: "job_not_completed" });
    expect(c.completeness.missing.map((m: any) => m.code)).toContain("job_not_completed");
    expect(c.snapshot.status).toBe("not_frozen");
  });

  it("a finished, fully recorded job: variance amount + percent, explained, margin labelled as quoted", async () => {
    fullJob = await newJob(usdProduct, 10, 500);
    await start(fullJob);
    await issue(fullJob, usdProduct.materialItems[0].id, 25); // 5 kg over: USD 50 vs 40 estimated
    await labour(fullJob, 3, 4, "USD"); // 12
    await completeJob(prodMgr, fullJob);
    const c = (await getJobCost(finance, fullJob)) as any;
    expect(c.actualBasis).toBe("snapshot");
    expect(c.lines[0].variance).toMatchObject({ amount: "10", percent: "25", comparable: true, reason: null });
    expect(c.profit).toMatchObject({ available: true, revenue: "500", revenueBasis: "quoted", actualCost: "62", grossProfit: "438", excludesOverhead: true });
    const m = c.materialBreakdown[0];
    expect(m).toMatchObject({ expectedQty: "20", issuedQty: "25", overIssuedQty: "5" });
    expect(m.explanation).toMatchObject({ comparable: true, usageVariance: "10", priceVariance: "0", totalVariance: "10" });
    expect(c.snapshot.status).toBe("frozen");
    expect(c.snapshot.evidence).toMatchObject({ costedMovements: 1, uncostedMovements: 0, labourRecords: 1 });
  });

  it("price variance is separated from usage variance", async () => {
    const p = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 2 }]);
    await rec(p.materialItems[0].id, 100, 3, "USD"); // bought at 3, standard is 2
    const j = await newJob(p, 5);
    await start(j);
    await issue(j, p.materialItems[0].id, 10); // exactly expected qty: 10 kg @ 3 = 30 vs 20
    const c = (await getJobCost(finance, j)) as any;
    expect(c.materialBreakdown[0].explanation).toMatchObject({ usageVariance: "0", priceVariance: "10", totalVariance: "10" });
  });

  it("a completed job with no labour shows no margin (cost is incomplete), and says what is missing", async () => {
    noLabourJob = await newJob(usdProduct, 5, 300);
    await start(noLabourJob);
    await issue(noLabourJob, usdProduct.materialItems[0].id, 10);
    await completeJob(prodMgr, noLabourJob);
    const c = (await getJobCost(finance, noLabourJob)) as any;
    expect(c.profit).toMatchObject({ available: false, reason: "no_labour_recorded" });
    expect(c.completeness.missing.map((m: any) => m.code)).toContain("no_labour_recorded");
    expect(c.completeness.labour).toBe("none_recorded");
    // unknown labour is null, never zero
    expect(c.lines[0].actual.labour).toBeNull();
    // the snapshot froze that knowledge
    const snap = await prisma.jobCostActual.findUnique({ where: { jobId: noLabourJob } });
    expect((snap!.completeness as any).marginBlockers).toContain("no_labour_recorded");
  });

  it("a completed job with nothing recorded never reports a margin, even with a quote", async () => {
    const j = await newJob(usdProduct, 1, 100);
    await start(j);
    await transitionJob(owner, j, { status: "in_progress" });
    await completeJob(prodMgr, j);
    const c = (await getJobCost(finance, j)) as any;
    expect(c.profit.available).toBe(false);
    expect(["no_actual_cost", "no_material_cost"]).toContain(c.profit.reason);
  });

  it("an unpriced estimate blocks variance but not the actual-cost margin", async () => {
    const p = await productWithActiveBom(owner, [{ uom: "kg", bomQty: 1 }]); // no standard cost
    await rec(p.materialItems[0].id, 50, 4, "USD");
    const j = await newJob(p, 3, 100);
    await start(j);
    await issue(j, p.materialItems[0].id, 3);
    await labour(j, 1, 5, "USD");
    await completeJob(prodMgr, j);
    const c = (await getJobCost(finance, j)) as any;
    expect(c.lines[0].variance).toMatchObject({ comparable: false, reason: "estimate_incomplete", percent: null });
    expect(c.materialBreakdown[0].explanation).toEqual({ comparable: false, reason: "unpriced" });
    expect(c.profit).toMatchObject({ available: true, actualCost: "17" });
  });

  it("multi-currency job: costs stay separate, no margin against a single quote, never blended", async () => {
    const j = await newJob(twoCcy, 10, 500);
    await start(j);
    await issue(j, twoCcy.materialItems[0].id, 20); // USD 40
    await issue(j, twoCcy.materialItems[1].id, 10); // ZIG 1000
    await labour(j, 1, 10, "USD");
    await completeJob(prodMgr, j);
    const c = (await getJobCost(finance, j)) as any;
    expect(c.lines.map((l: any) => [l.currency, l.actual.material])).toEqual([["USD", "40"], ["ZIG", "1000"]]);
    expect(c.profit).toMatchObject({ available: false, reason: "mixed_currencies" });
  });

  it("the profitability report applies the same gate (no-labour job is excluded, not shown profitable)", async () => {
    const r = (await getProfitabilityReport(finance, { productItemId: usdProduct.product.id })) as any;
    const row = (id: string) => r.rows.find((x: any) => x.jobId === id);
    expect(row(fullJob).profit.available).toBe(true);
    expect(row(noLabourJob).profit).toMatchObject({ available: false, reason: "no_labour_recorded" });
    expect(row(noLabourJob).missing).toContain("no_labour_recorded");
    const usd = r.totalsByCurrency.find((t: any) => t.currency === "USD");
    expect(usd.jobs).toBe(1); // only the complete job contributes
  });

  it("operators and viewers get no cost detail at all", async () => {
    await expect(getJobCost(operator, fullJob)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
describe("completion snapshot: database protection", () => {
  let done: string;
  beforeAll(async () => {
    done = await newJob(usdProduct, 2, 100);
    await start(done);
    await issue(done, usdProduct.materialItems[0].id, 4);
    await labour(done, 1, 5, "USD");
    await completeJob(prodMgr, done);
  });

  it("a snapshot cannot be written for a job that is not completed", async () => {
    const open = await newJob(usdProduct, 1);
    await expect(prisma.jobCostActual.create({ data: { orgId: org.organizationId, jobId: open } })).rejects.toBeTruthy();
    expect(await prisma.jobCostActual.count({ where: { jobId: open } })).toBe(0);
  });

  it("a currency line cannot be appended to a frozen snapshot afterwards", async () => {
    await expect(
      prisma.jobCostActualLine.create({ data: { orgId: org.organizationId, jobId: done, currency: "ZIG", actualMaterialCost: 1 } }),
    ).rejects.toBeTruthy();
    expect(await prisma.jobCostActualLine.count({ where: { jobId: done } })).toBe(1);
  });

  it("the completeness/evidence columns are frozen too", async () => {
    await expect(prisma.jobCostActual.update({ where: { jobId: done }, data: { evidence: {} } })).rejects.toBeTruthy();
    await expect(prisma.jobCostActual.update({ where: { jobId: done }, data: { completeness: {} } })).rejects.toBeTruthy();
  });

  it("a completed job cannot be reopened, even by a direct database write", async () => {
    await expect(prisma.productionJob.updateMany({ where: { id: done }, data: { status: "in_progress" } })).rejects.toBeTruthy();
    await expect(prisma.productionJob.updateMany({ where: { id: done }, data: { status: "cancelled" } })).rejects.toBeTruthy();
    // ...but the legitimate forward step still works
    await expect(transitionJob(owner, done, { status: "closed" })).resolves.toBeTruthy();
  });

  it("no ledger or labour row can be posted to a completed job", async () => {
    await expect(issue(done, usdProduct.materialItems[0].id, 1)).rejects.toBeTruthy();
    await expect(labour(done, 1, 1, "USD")).rejects.toBeTruthy();
    // and a raw insert is refused by the database itself
    await expect(prisma.labourRecord.create({ data: { orgId: org.organizationId, jobId: done, hours: 1, rate: 1, rateCurrency: "USD" } })).rejects.toBeTruthy();
    const snap = (await getJobCost(finance, done)) as any;
    expect(snap.lines[0].actual.material).toBe("8");
  });
});

// ---------------------------------------------------------------------------
describe("completion snapshot: concurrency and rollback", () => {
  it("concurrent completion attempts produce exactly one snapshot", async () => {
    const j = await newJob(usdProduct, 2, 100);
    await start(j);
    await issue(j, usdProduct.materialItems[0].id, 4);
    await labour(j, 1, 5, "USD");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => completeJob(prodMgr, j)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    }
    expect(await prisma.jobCostActual.count({ where: { jobId: j } })).toBe(1);
    expect(await prisma.jobCostActualLine.count({ where: { jobId: j } })).toBe(1);
    const audits = await prisma.auditLog.count({ where: { entityType: "job_cost_actual", entityId: j } });
    expect(audits).toBe(1);
  });

  it("a posting racing completion is either IN the snapshot or refused, never lost", async () => {
    const itemId = usdProduct.materialItems[0].id;
    for (let i = 0; i < 8; i++) {
      const j = await newJob(usdProduct, 10);
      await start(j);
      await issue(j, itemId, 1); // moves it to in_progress
      const [issued, completed] = await Promise.allSettled([issue(j, itemId, 2), completeJob(prodMgr, j)]);
      expect(completed.status).toBe("fulfilled");
      const snapshot = await prisma.jobCostActualLine.findMany({ where: { jobId: j } });
      const ledger = ((await computeActualCostLines(prisma, org.organizationId, [j])).get(j) ?? []).map((l) => [l.currency, l.materialCost.toString()]);
      // Whatever the interleaving, the frozen figure equals the ledger afterwards:
      expect(snapshot.map((l) => [l.currency.trim(), String(l.actualMaterialCost)])).toEqual(ledger);
      expect(snapshot[0] && String(snapshot[0].actualMaterialCost)).toBe(issued.status === "fulfilled" ? "6" : "2");
    }
  }, 60_000);

  it("a failure while snapshotting rolls the whole completion back", async () => {
    const j = await newJob(usdProduct, 2, 100);
    await start(j);
    await issue(j, usdProduct.materialItems[0].id, 4);
    // labour_record.rate_currency has no foreign key, so a bad code can exist; the
    // snapshot line's currency IS a foreign key, which makes the snapshot fail.
    await prisma.labourRecord.create({ data: { orgId: org.organizationId, jobId: j, hours: 1, rate: 1, rateCurrency: "QQQ" } });
    await expect(completeJob(prodMgr, j)).rejects.toBeTruthy();
    const job = await prisma.productionJob.findUnique({ where: { id: j } });
    expect(job!.status).not.toBe("completed");
    expect(job!.actualEnd).toBeNull();
    expect(await prisma.jobCostActual.count({ where: { jobId: j } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityType: "job_cost_actual", entityId: j } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("cost adjustments (explicit, audited corrections to a frozen job)", () => {
  let jobId: string;
  const adj = (s: AuthenticatedSession, id: string, body: Partial<Record<string, unknown>> = {}) =>
    recordCostAdjustment(s, id, { clientRequestId: randomUUID(), currency: "USD", component: "labour", amount: 20, reason: "Missed timesheet for night shift", ...body });

  beforeAll(async () => {
    jobId = await newJob(usdProduct, 5, 300);
    await start(jobId);
    await issue(jobId, usdProduct.materialItems[0].id, 10); // USD 20
    await completeJob(prodMgr, jobId); // no labour => margin withheld
  });

  it("only Owner/Admin and Finance hold cost:adjust", () => {
    expect(capabilitiesFor("FINANCE_MANAGER")).toContain("cost:adjust");
    expect(capabilitiesFor("OWNER_ADMIN")).toContain("cost:adjust");
    for (const r of ["OPERATIONS_MANAGER", "PRODUCTION_MANAGER", "INVENTORY_MANAGER", "PRODUCTION_OPERATOR", "VIEWER"] as const) {
      expect(capabilitiesFor(r)).not.toContain("cost:adjust");
    }
  });

  it("is refused for roles without the capability", async () => {
    await expect(adj(prodMgr, jobId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(adj(operator, jobId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("is refused before the job is completed (record the issue or labour instead)", async () => {
    const open = await newJob(usdProduct, 1);
    await expect(adj(finance, open)).rejects.toBeInstanceOf(ConflictError);
  });

  it("validates amount, currency and a real reason", async () => {
    await expect(adj(finance, jobId, { amount: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(adj(finance, jobId, { amount: 1.00001 })).rejects.toBeInstanceOf(ValidationError);
    await expect(adj(finance, jobId, { reason: "short" })).rejects.toBeInstanceOf(ValidationError);
    await expect(adj(finance, jobId, { currency: "XXX" })).rejects.toBeInstanceOf(ValidationError);
    await expect(adj(finance, jobId, { component: "overhead" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("cannot drive a cost negative", async () => {
    await expect(adj(finance, jobId, { component: "material", amount: -21 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("records the correction, leaves the snapshot untouched, and unlocks the margin", async () => {
    const before = (await getJobCost(finance, jobId)) as any;
    expect(before.profit).toMatchObject({ available: false, reason: "no_labour_recorded" });

    const r = await adj(finance, jobId, { amount: 20 });
    expect(r.replayed).toBe(false);
    const after = (await getJobCost(finance, jobId)) as any;
    // frozen snapshot values are unchanged...
    expect(after.lines[0].actual.material).toBe("20");
    expect(after.lines[0].actual.labour).toBeNull();
    // ...the correction is visible next to them
    expect(after.lines[0].adjustments).toEqual({ material: null, labour: "20" });
    expect(after.lines[0].adjusted).toEqual({ material: "20", labour: "20" });
    expect(after.adjustments).toHaveLength(1);
    expect(after.adjustments[0]).toMatchObject({ component: "labour", amount: "20", reason: "Missed timesheet for night shift" });
    expect(after.profit).toMatchObject({ available: true, actualCost: "40", grossProfit: "260" });

    const audit = await prisma.auditLog.findFirst({ where: { entityType: "job_cost_adjustment", entityId: r.adjustment.id } });
    expect(audit).toMatchObject({ action: "create", reason: "Missed timesheet for night shift", actorUserId: finance.userId });
  });

  it("the profitability report uses the adjusted cost", async () => {
    const r = (await getProfitabilityReport(finance, { productItemId: usdProduct.product.id })) as any;
    const row = r.rows.find((x: any) => x.jobId === jobId);
    expect(row.adjusted).toBe(true);
    expect(row.profit).toMatchObject({ available: true, actualCost: "40" });
  });

  it("is idempotent: the same clientRequestId replays, a different payload under it is a conflict", async () => {
    const id = randomUUID();
    const a = await adj(finance, jobId, { clientRequestId: id, component: "material", amount: 1.5, reason: "Rounding correction on issue" });
    const b = await adj(finance, jobId, { clientRequestId: id, component: "material", amount: 1.5, reason: "Rounding correction on issue" });
    expect(b.replayed).toBe(true);
    expect(b.adjustment.id).toBe(a.adjustment.id);
    await expect(adj(finance, jobId, { clientRequestId: id, component: "material", amount: 9, reason: "Rounding correction on issue" })).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.jobCostAdjustment.count({ where: { jobId, clientRequestId: id } })).toBe(1);
  });

  it("concurrent identical submissions create one adjustment", async () => {
    const id = randomUUID();
    const rs = await Promise.allSettled(Array.from({ length: 5 }, () => adj(finance, jobId, { clientRequestId: id, component: "material", amount: 0.5, reason: "Concurrent retry check" })));
    expect(rs.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.jobCostAdjustment.count({ where: { jobId, clientRequestId: id } })).toBe(1);
  });

  it("adjustments are immutable and need a snapshot at the database level", async () => {
    const row = await prisma.jobCostAdjustment.findFirst({ where: { jobId } });
    await expect(prisma.jobCostAdjustment.update({ where: { id: row!.id }, data: { amount: 1 } })).rejects.toBeTruthy();
    await expect(prisma.jobCostAdjustment.delete({ where: { id: row!.id } })).rejects.toBeTruthy();
    const open = await newJob(usdProduct, 1);
    await expect(
      prisma.jobCostAdjustment.create({ data: { orgId: org.organizationId, jobId: open, currency: "USD", component: "labour", amount: 5, reason: "Direct insert should be refused" } }),
    ).rejects.toBeTruthy();
  });

  it("tenant and branch isolation", async () => {
    await expect(adj(finance2, jobId)).rejects.toBeInstanceOf(NotFoundError); // other branch
    await expect(adj(ownerB, jobId)).rejects.toBeInstanceOf(NotFoundError); // other organization
    await expect(getJobCost(finance2, jobId)).rejects.toBeInstanceOf(NotFoundError);
    expect(((await getProfitabilityReport(ownerB, {})) as any).rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("exchange rates: historical stability", () => {
  const rate = (s: AuthenticatedSession, r: number, asOf: string, base = "ZIG", quote = "USD") =>
    recordExchangeRate(s, { baseCurrency: base, quoteCurrency: quote, rate: r, asOfDate: asOf, source: "MANUAL" });
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let doneJob: string;
  let r1: string;

  beforeAll(async () => {
    r1 = (await rate(finance, 0.01, yesterday)).id;
    await sleep(15);
    doneJob = await newJob(twoCcy, 10, 500);
    await start(doneJob);
    await issue(doneJob, twoCcy.materialItems[0].id, 20); // USD 40
    await issue(doneJob, twoCcy.materialItems[1].id, 10); // ZIG 1000
    await labour(doneJob, 1, 10, "USD");
    await completeJob(prodMgr, doneJob);
    await sleep(15);
  });

  it("rates are validated (zero, negative, same-currency, future, unknown) and authorised", async () => {
    await expect(rate(finance, 0, today)).rejects.toBeInstanceOf(ValidationError);
    await expect(rate(finance, -1, today)).rejects.toBeInstanceOf(ValidationError);
    await expect(rate(finance, 1, today, "USD", "USD")).rejects.toBeInstanceOf(ValidationError);
    await expect(rate(finance, 1, "2999-01-01")).rejects.toBeInstanceOf(ValidationError);
    await expect(rate(finance, 1, today, "ZIG", "QQQ")).rejects.toBeInstanceOf(ValidationError);
    await expect(rate(prodMgr, 1, today)).rejects.toBeInstanceOf(ForbiddenError);
    // and the database independently refuses a non-positive rate
    await expect(prisma.exchangeRate.create({ data: { orgId: org.organizationId, baseCurrency: "ZIG", quoteCurrency: "USD", rate: 0, asOfDate: new Date(), source: "MANUAL" } })).rejects.toBeTruthy();
  });

  it("a completed job converts with the rate on record at completion, and cites it", async () => {
    const c = (await getJobCost(finance, doneJob, { convertTo: "USD" })) as any;
    expect(c.conversion.basis).toBe("as_of_completion");
    const zig = c.conversion.groups.find((g: any) => g.currency === "ZIG");
    expect(zig.rate.id).toBe(r1);
    expect(c.conversion.totals.actualMaterial).toBe("50"); // 40 + 1000 x 0.01
  });

  it("recording a NEWER rate later does not change the completed job's converted figure", async () => {
    await rate(finance, 0.05, today);
    const c = (await getJobCost(finance, doneJob, { convertTo: "USD" })) as any;
    expect(c.conversion.groups.find((g: any) => g.currency === "ZIG").rate.id).toBe(r1);
    expect(c.conversion.totals.actualMaterial).toBe("50");
  });

  it("recording a BACK-DATED rate after completion does not rewrite it either", async () => {
    await rate(finance, 0.02, yesterday); // dated before completion, entered after
    const c = (await getJobCost(finance, doneJob, { convertTo: "USD" })) as any;
    expect(c.conversion.groups.find((g: any) => g.currency === "ZIG").rate.id).toBe(r1);
    expect(c.conversion.totals.actualMaterial).toBe("50");
  });

  it("an explicit asOf is labelled as such and uses the newest rate in force on that date", async () => {
    const c = (await getJobCost(finance, doneJob, { convertTo: "USD", asOf: today })) as any;
    expect(c.conversion.basis).toBe("as_of_date");
    expect(c.conversion.groups.find((g: any) => g.currency === "ZIG").rate.rate).toBe("0.05");
    expect(c.conversion.totals.actualMaterial).toBe("90");
  });

  it("an open job uses the latest recorded rate and says so", async () => {
    const j = await newJob(twoCcy, 10, 500);
    await start(j);
    await issue(j, twoCcy.materialItems[1].id, 10);
    const c = (await getJobCost(finance, j, { convertTo: "USD" })) as any;
    expect(c.conversion.basis).toBe("latest");
    expect(c.conversion.groups.find((g: any) => g.currency === "ZIG").rate.rate).toBe("0.05");
  });

  it("no rate on record at completion means no converted total (never today's rate by stealth)", async () => {
    const j = await newJob(twoCcy, 10, 500);
    await start(j);
    await issue(j, twoCcy.materialItems[1].id, 10);
    await issue(j, twoCcy.materialItems[0].id, 5);
    await labour(j, 1, 1, "USD");
    await completeJob(prodMgr, j);
    // a rate for a DIFFERENT pair exists; for ZIG->ZAR nothing was on record
    const c = (await getJobCost(finance, j, { convertTo: "ZAR" })) as any;
    expect(c.conversion.available).toBe(false);
    expect(c.conversion.totals).toBeNull();
  });

  it("conversion is isolated per organization", async () => {
    await expect(getJobCost(ownerB, doneJob, { convertTo: "USD" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
