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
import { getJobCost, listJobCosts, getProfitabilityReport } from "../cost-service";
import { ForbiddenError, NotFoundError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let finance: AuthenticatedSession;
let prodMgr: AuthenticatedSession;
let prodMgr2: AuthenticatedSession;
let operator: AuthenticatedSession;
let viewer: AuthenticatedSession;
let inv: AuthenticatedSession;
let wh1: string;
let p1: Awaited<ReturnType<typeof productWithActiveBom>>; // two currencies
let p2: Awaited<ReturnType<typeof productWithActiveBom>>; // single currency
let mixedJob: string;
let usdJob: string;
let noQuoteJob: string;

const rec = (itemId: string, quantity: number, unitCost: number, currency: string) =>
  receiveStock(ownerA, { clientRequestId: randomUUID(), warehouseId: wh1, itemId, quantity, unitCost, currency });
const issue = (jobId: string, materialItemId: string, quantity: number) =>
  issueMaterialToJob(ownerA, jobId, { clientRequestId: randomUUID(), materialItemId, warehouseId: wh1, quantity });
const labour = (jobId: string, hours: number, rate: number, rateCurrency: string) =>
  recordLabour(prodMgr, jobId, { clientRequestId: randomUUID(), hours, rate, rateCurrency });
const release = (jobId: string) => transitionJob(ownerA, jobId, { status: "released" });

beforeAll(async () => {
  orgA = await createTestOrg("costA");
  orgB = await createTestOrg("costB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  wh1 = (await createWarehouse(ownerA, { branchId: orgA.branchId, name: "Main store" })).id;
  finance = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fm", [orgA.branchId]);
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
  prodMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm2", [branch2]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "vw", [orgA.branchId]);
  inv = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "inv", [orgA.branchId]);

  p1 = await productWithActiveBom(ownerA, [
    { uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 2 },
    { uom: "ea", standardCost: 100, standardCostCurrency: "ZIG", bomQty: 1 },
  ]);
  p2 = await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 1 }]);
  await rec(p1.materialItems[0].id, 100, 2, "USD");
  await rec(p1.materialItems[1].id, 50, 100, "ZIG");
  await rec(p2.materialItems[0].id, 100, 2, "USD");

  // Job with cost in TWO currencies: est USD 40 + ZIG 1000; quote 500 USD.
  const mj = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: p1.product.id, plannedQty: 10, quotedAmount: 500, quotedCurrency: "USD" })) as any;
  mixedJob = mj.id;
  await release(mixedJob);
  await issue(mixedJob, p1.materialItems[0].id, 25); // 5 kg over the expected 20 => USD 50
  await issue(mixedJob, p1.materialItems[1].id, 10); // ZIG 1000
  await labour(mixedJob, 3, 4, "USD"); // USD 12
  await labour(mixedJob, 2, 50, "ZIG"); // ZIG 100
}, 300_000);

describe("live job cost (before completion)", () => {
  it("groups estimate, actual and variance per currency and never blends them", async () => {
    const c = (await getJobCost(finance, mixedJob)) as any;
    expect(c.actualBasis).toBe("live");
    expect(c.lines.map((l: any) => l.currency)).toEqual(["USD", "ZIG"]);
    const usd = c.lines[0], zig = c.lines[1];
    expect(usd.estimated.material).toBe("40");
    expect(usd.actual.material).toBe("50");
    expect(usd.actual.labour).toBe("12");
    expect(usd.variance.material).toBe("10"); // over estimate
    expect(zig.estimated.material).toBe("1000");
    expect(zig.actual.material).toBe("1000");
    expect(zig.actual.labour).toBe("100");
    expect(zig.variance.material).toBe("0");
    expect(c.overhead).toBe("unavailable");
    expect(c.lines.every((l: any) => l.actual.overhead === null && l.estimated.overhead === null)).toBe(true);
    expect(c.varianceReliable).toBe(true);
  });

  it("profit is unavailable when cost spans a currency other than the quote's", async () => {
    const c = (await getJobCost(finance, mixedJob)) as any;
    expect(c.profit).toEqual({ available: false, reason: "mixed_currencies" });
  });

  it("flags an estimate with unpriced materials as an unreliable variance", async () => {
    const p = await productWithActiveBom(ownerA, [{ uom: "kg", bomQty: 1 }]); // no standard cost
    const j = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: p.product.id, plannedQty: 1 })) as any;
    const c = (await getJobCost(finance, j.id)) as any;
    expect(c.varianceReliable).toBe(false);
    expect(c.isMaterialEstimateComplete).toBe(false);
    expect(c.unpricedMaterials).toHaveLength(1);
  });

  it("only cost:read holders see it: finance and production manager yes; operator, viewer, inventory no", async () => {
    await expect(getJobCost(prodMgr, mixedJob)).resolves.toBeTruthy();
    for (const s of [operator, viewer, inv]) {
      await expect(getJobCost(s, mixedJob)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("branch and tenant isolation", async () => {
    await expect(getJobCost(prodMgr2, mixedJob)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getJobCost(ownerB, mixedJob)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the batch summary matches the single-job figures", async () => {
    const rows = (await listJobCosts(finance, {})) as any[];
    const row = rows.find((r) => r.jobId === mixedJob);
    expect(row.actualBasis).toBe("live");
    expect(row.lines[0].actual.material).toBe("50");
    await expect(listJobCosts(operator, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("opt-in currency conversion", () => {
  it("offers no total when a currency has no recorded rate", async () => {
    const c = (await getJobCost(finance, mixedJob, { convertTo: "USD" })) as any;
    expect(c.conversion.available).toBe(false);
    expect(c.conversion.totals).toBeNull();
    const zig = c.conversion.groups.find((g: any) => g.currency === "ZIG");
    expect(zig.rate).toBeNull();
    expect(zig.converted).toBe(false);
  });

  it("uses the LATEST recorded rate and cites the exact rate row", async () => {
    await recordExchangeRate(finance, { baseCurrency: "ZIG", quoteCurrency: "USD", rate: 0.04, asOfDate: "2026-09-01", source: "MANUAL" });
    const newest = await recordExchangeRate(finance, { baseCurrency: "ZIG", quoteCurrency: "USD", rate: 0.05, asOfDate: "2026-10-01", source: "MANUAL" });
    const c = (await getJobCost(finance, mixedJob, { convertTo: "USD" })) as any;
    expect(c.conversion.available).toBe(true);
    const zig = c.conversion.groups.find((g: any) => g.currency === "ZIG");
    expect(zig.rate.id).toBe(newest.id);
    expect(zig.rate.rate).toBe("0.05");
    expect(zig.rate.source).toBe("MANUAL");
    expect(c.conversion.totals).toEqual({
      currency: "USD",
      estimatedMaterial: "90", // 40 + 1000 x 0.05
      actualMaterial: "100", // 50 + 1000 x 0.05
      actualLabour: "17", // 12 + 100 x 0.05
    });
    // The grouped figures are untouched by asking for a conversion.
    expect(c.lines).toHaveLength(2);
  });

  it("respects the requested rate source", async () => {
    const c = (await getJobCost(finance, mixedJob, { convertTo: "USD", rateSource: "RBZ_OFFICIAL" })) as any;
    expect(c.conversion.available).toBe(false);
  });

  it("another organization's rates are never used", async () => {
    await recordExchangeRate(ownerB, { baseCurrency: "ZIG", quoteCurrency: "ZAR", rate: 9, asOfDate: "2026-10-01", source: "MANUAL" });
    const c = (await getJobCost(finance, mixedJob, { convertTo: "ZAR" })) as any;
    expect(c.conversion.available).toBe(false);
  });

  it("converting requires the right to read exchange rates", async () => {
    await expect(getJobCost(prodMgr, mixedJob, { convertTo: "USD" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("completion snapshot", () => {
  it("completing freezes actual cost per currency, in the same step as the status change", async () => {
    await completeJob(prodMgr, mixedJob);
    const snap = await prisma.jobCostActual.findUnique({ where: { jobId: mixedJob } });
    expect(snap).toBeTruthy();
    expect(String(snap!.revenue)).toBe("500");
    expect(snap!.revenueCurrency?.trim()).toBe("USD");
    const lines = await prisma.jobCostActualLine.findMany({ where: { jobId: mixedJob }, orderBy: { currency: "asc" } });
    expect(lines.map((l) => [l.currency.trim(), String(l.actualMaterialCost), String(l.actualLabourCost)])).toEqual([
      ["USD", "50", "12"],
      ["ZIG", "1000", "100"],
    ]);
    expect(lines.every((l) => l.actualOverheadCost === null)).toBe(true);

    const c = (await getJobCost(finance, mixedJob)) as any;
    expect(c.actualBasis).toBe("snapshot");
    expect(c.snapshottedAt).toBeTruthy();
    expect(c.lines[0].actual.material).toBe("50");
  });

  it("the snapshot is immutable at the database level", async () => {
    await expect(prisma.jobCostActualLine.updateMany({ where: { jobId: mixedJob }, data: { actualMaterialCost: 1 } })).rejects.toBeTruthy();
    await expect(prisma.jobCostActualLine.deleteMany({ where: { jobId: mixedJob } })).rejects.toBeTruthy();
    await expect(prisma.jobCostActual.update({ where: { jobId: mixedJob }, data: { revenue: 1 } })).rejects.toBeTruthy();
    await expect(prisma.jobCostActual.delete({ where: { jobId: mixedJob } })).rejects.toBeTruthy();
    const c = (await getJobCost(finance, mixedJob)) as any;
    expect(c.lines[0].actual.material).toBe("50");
  });

  it("single-currency job: profit and margin are computed from the snapshot", async () => {
    const j = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: p2.product.id, plannedQty: 5, quotedAmount: 100, quotedCurrency: "USD" })) as any;
    usdJob = j.id;
    await release(usdJob);
    await issue(usdJob, p2.materialItems[0].id, 5); // 5 x 2 = 10
    await labour(usdJob, 2, 3, "USD"); // 6
    await completeJob(prodMgr, usdJob);
    const c = (await getJobCost(finance, usdJob)) as any;
    expect(c.profit).toMatchObject({ available: true, currency: "USD", revenue: "100", actualCost: "16", grossProfit: "84", marginPercent: "84", excludesOverhead: true });
  });

  it("a job with no quote has no profit; one with no consumption snapshots an empty cost, not an invented one", async () => {
    const j = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: p2.product.id, plannedQty: 1 })) as any;
    noQuoteJob = j.id;
    await release(noQuoteJob);
    await transitionJob(ownerA, noQuoteJob, { status: "in_progress" });
    await completeJob(prodMgr, noQuoteJob);
    const c = (await getJobCost(finance, noQuoteJob)) as any;
    expect(c.profit).toEqual({ available: false, reason: "no_revenue" });
    expect(c.lines[0].actual.material).toBe("0");
    expect(c.lines[0].actual.labour).toBeNull();
    expect(await prisma.jobCostActualLine.count({ where: { jobId: noQuoteJob } })).toBe(0);
  });

  it("the batch summary reads the snapshot for completed jobs", async () => {
    const rows = (await listJobCosts(finance, { status: "completed" })) as any[];
    expect(rows.find((r) => r.jobId === usdJob).actualBasis).toBe("snapshot");
  });
});

describe("profitability report", () => {
  it("lists completed jobs with profit only where it is computable, totals grouped by currency", async () => {
    const r = (await getProfitabilityReport(finance, { productItemId: p2.product.id })) as any;
    expect(r.rows.map((x: any) => x.jobId).sort()).toEqual([usdJob, noQuoteJob].sort());
    expect(r.totalsByCurrency).toEqual([
      { currency: "USD", jobs: 1, revenue: "100", actualCost: "16", grossProfit: "84", marginPercent: "84" },
    ]);
    expect(r.excludedJobs).toBe(1); // the job with no quote
    expect(r.excludesOverhead).toBe(true);
  });

  it("a mixed-currency job is excluded from totals rather than blended in", async () => {
    const r = (await getProfitabilityReport(finance, { productItemId: p1.product.id })) as any;
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].profit.reason).toBe("mixed_currencies");
    expect(r.totalsByCurrency).toEqual([]);
    expect(r.excludedJobs).toBe(1);
  });

  it("only cost readers; scoped to branch and organization", async () => {
    await expect(getProfitabilityReport(operator, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getProfitabilityReport(viewer, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(((await getProfitabilityReport(prodMgr2, {})) as any).rows).toHaveLength(0);
    expect(((await getProfitabilityReport(ownerB, {})) as any).rows).toHaveLength(0);
    await expect(getProfitabilityReport(prodMgr2, { branchId: orgA.branchId })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("date filters apply to completion time", async () => {
    const future = (await getProfitabilityReport(finance, { from: "2999-01-01" })) as any;
    expect(future.rows).toHaveLength(0);
    const past = (await getProfitabilityReport(finance, { to: "2000-01-01" })) as any;
    expect(past.rows).toHaveLength(0);
  });
});
