// Milestone 4: capacity visibility -- simple date-bucketed assigned load vs.
// configured daily capacity. NOT finite-capacity scheduling; see the file
// header of capacity-service.ts for the full disclaimer this suite checks
// the code actually honours (no utilisation % without a configured
// capacity, no load from closed jobs, no load from a stage with nothing
// estimated).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createWorkCentre, updateWorkCentre } from "../machine-service";
import { createJob, transitionJob } from "../job-service";
import { defineStages } from "../stage-service";
import { getCapacityVisibility } from "../capacity-service";
import { ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

let org: TestOrg;
let owner: AuthenticatedSession;
let mgr: AuthenticatedSession;
let productId: string;

beforeAll(async () => {
  org = await createTestOrg("capA");
  owner = await ownerSession(org);
  mgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "cap-mgr", [org.branchId]);
  productId = (await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
}, 180_000);

function iso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
}
function dayOf(daysFromNow: number): string {
  return iso(daysFromNow).slice(0, 10);
}

async function jobWithStage(
  wcId: string,
  stage: { plannedStart?: string; plannedEnd?: string; expectedSetupMinutes?: number; expectedRunMinutes?: number },
  release = true,
) {
  const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
  await defineStages(mgr, job.id, { stages: [{ name: "Run", workCentreId: wcId, ...stage }] });
  if (release) await transitionJob(owner, job.id, { status: "released" });
  return job.id as string;
}

describe("getCapacityVisibility", () => {
  it("reports assigned minutes with no utilisation % or overCapacity flag when the work centre has no configured capacity", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-nocap`, name: "No capacity configured" });
    await jobWithStage(wc.id, { plannedStart: iso(1), plannedEnd: iso(1), expectedSetupMinutes: 30, expectedRunMinutes: 90 });

    const report: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(3) });
    const row = report.workCentres.find((w: any) => w.id === wc.id);
    const day = row.days.find((d: any) => d.date === dayOf(1));
    expect(day.assignedMinutes).toBe(120);
    expect(day.capacityMinutes).toBeNull();
    expect(day.utilisationPct).toBeNull();
    expect(day.overCapacity).toBeNull();
  });

  it("computes utilisation % and flags over-capacity days once a daily capacity is configured", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-withcap`, name: "480/day", dailyCapacityMinutes: 480 });
    await jobWithStage(wc.id, { plannedStart: iso(1), plannedEnd: iso(1), expectedSetupMinutes: 100, expectedRunMinutes: 500 });

    const report: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(3) });
    const row = report.workCentres.find((w: any) => w.id === wc.id);
    const day = row.days.find((d: any) => d.date === dayOf(1));
    expect(day.assignedMinutes).toBe(600);
    expect(day.capacityMinutes).toBe(480);
    expect(day.utilisationPct).toBe(125);
    expect(day.overCapacity).toBe(true);
  });

  it("a stage with only plannedStart (no plannedEnd) is bucketed onto that single day", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-onestart`, name: "One date" });
    await jobWithStage(wc.id, { plannedStart: iso(2), expectedSetupMinutes: 10, expectedRunMinutes: 20 });

    const report: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(5) });
    const row = report.workCentres.find((w: any) => w.id === wc.id);
    expect(row.days.map((d: any) => d.date)).toEqual([dayOf(2)]);
    expect(row.days[0].assignedMinutes).toBe(30);
  });

  it("a stage spanning several days spreads its total minutes evenly across them", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-span`, name: "Spans 3 days" });
    await jobWithStage(wc.id, { plannedStart: iso(1), plannedEnd: iso(3), expectedSetupMinutes: 0, expectedRunMinutes: 300 });

    const report: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(5) });
    const row = report.workCentres.find((w: any) => w.id === wc.id);
    const days = row.days.filter((d: any) => [dayOf(1), dayOf(2), dayOf(3)].includes(d.date));
    expect(days).toHaveLength(3);
    expect(days.every((d: any) => d.assignedMinutes === 100)).toBe(true);
  });

  it("a stage with neither setup nor run minutes estimated contributes no load", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-zero`, name: "Nothing estimated" });
    await jobWithStage(wc.id, { plannedStart: iso(1), plannedEnd: iso(1) });

    const report: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(3) });
    const row = report.workCentres.find((w: any) => w.id === wc.id);
    expect(row.days).toEqual([]);
  });

  it("a stage with no planned dates at all is excluded (nothing to bucket onto)", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-nodates`, name: "No dates" });
    await jobWithStage(wc.id, { expectedSetupMinutes: 10, expectedRunMinutes: 10 });

    const report: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(3) });
    const row = report.workCentres.find((w: any) => w.id === wc.id);
    expect(row.days).toEqual([]);
  });

  it("only OPEN jobs (planned/released/in_progress/on_hold) contribute load -- a cancelled job's stage does not", async () => {
    // Cancelling (not completing) a never-started job: completing would
    // require the stage to actually be finished first (assertReadyToComplete),
    // which is a different code path this test isn't about. "cancelled" is
    // simplest terminal, non-open status reachable with no other preconditions.
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-closed`, name: "Will cancel" });
    const jobId = await jobWithStage(wc.id, { plannedStart: iso(1), plannedEnd: iso(1), expectedSetupMinutes: 10, expectedRunMinutes: 10 });
    const before: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(3) });
    expect(before.workCentres[0].days).toHaveLength(1);

    await transitionJob(mgr, jobId, { status: "cancelled", reason: "test teardown" });
    const after: any = await getCapacityVisibility(mgr, { workCentreId: wc.id, from: iso(0), to: iso(3) });
    expect(after.workCentres[0].days).toEqual([]);
  });

  it("an inactive work centre is excluded from the report entirely", async () => {
    const wc: any = await createWorkCentre(mgr, { branchId: org.branchId, code: `CAP-${Date.now()}-inactive`, name: "Will deactivate" });
    await updateWorkCentre(mgr, wc.id, { isActive: false });
    const report: any = await getCapacityVisibility(mgr, { from: iso(0), to: iso(3) });
    expect(report.workCentres.some((w: any) => w.id === wc.id)).toBe(false);
  });

  it("rejects `to` before `from`, and an unknown or inaccessible workCentreId", async () => {
    await expect(getCapacityVisibility(mgr, { from: iso(5), to: iso(1) })).rejects.toBeInstanceOf(ValidationError);
    await expect(getCapacityVisibility(mgr, { workCentreId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("defaults to a yesterday..+14-day window when no from/to is given", async () => {
    const report: any = await getCapacityVisibility(mgr, {});
    const from = new Date(report.from);
    const to = new Date(report.to);
    expect(to.getTime() - from.getTime()).toBeGreaterThan(14 * 86_400_000 - 1000);
    expect(to.getTime() - from.getTime()).toBeLessThan(16 * 86_400_000);
  });
});
