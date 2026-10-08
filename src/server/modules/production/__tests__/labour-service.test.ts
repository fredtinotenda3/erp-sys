/* eslint-disable @typescript-eslint/no-explicit-any -- job/labour views are intentionally loose Record<string, unknown> projections; tests read fields by name */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { listAuditLog } from "../../iam/audit-service";
import { prisma } from "../../../shared/db";
import { createJob, getJob, transitionJob, completeJob } from "../job-service";
import { recordLabour } from "../labour-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let prodMgr: AuthenticatedSession;
let prodMgr2: AuthenticatedSession;
let operator: AuthenticatedSession;
let viewer: AuthenticatedSession;
let finance: AuthenticatedSession;
let inventoryMgr: AuthenticatedSession;
let productId: string;

const payload = (over: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  hours: 2.5,
  rate: 4,
  rateCurrency: "USD",
  ...over,
});

beforeAll(async () => {
  orgA = await createTestOrg("labA");
  orgB = await createTestOrg("labB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
  prodMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm2", [branch2]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "vw", [orgA.branchId]);
  finance = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fm", [orgA.branchId]);
  inventoryMgr = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "im", [orgA.branchId]);
  productId = (await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
}, 180_000);

async function releasedJob(): Promise<string> {
  const job = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: productId, plannedQty: 1 })) as Record<string, any>;
  await transitionJob(ownerA, job.id, { status: "released" });
  return job.id;
}

const count = (clientRequestId: string) => prisma.labourRecord.count({ where: { orgId: orgA.organizationId, clientRequestId } });

describe("recordLabour", () => {
  it("records hours, moves a released job to in_progress, and audits both", async () => {
    const id = await releasedJob();
    const res = await recordLabour(operator, id, payload());
    expect(res.replayed).toBe(false);
    expect(String(res.record.hours)).toBe("2.5");

    const job = (await getJob(ownerA, id)) as Record<string, any>;
    expect(job.status).toBe("in_progress");
    expect(job.actualStart).toBeTruthy();

    const entries = (await listAuditLog(ownerA, { entityType: "labour_record", entityId: res.record.id as string })) as any[];
    expect(entries.some((e) => e.action === "create")).toBe(true);
    const jobEntries = (await listAuditLog(ownerA, { entityType: "production_job", entityId: id })) as any[];
    expect(jobEntries.some((e) => e.reason === "first labour record")).toBe(true);
  });

  it("is idempotent: the same clientRequestId returns the original row and writes nothing new", async () => {
    const id = await releasedJob();
    const p = payload();
    const first = await recordLabour(operator, id, p);
    const second = await recordLabour(operator, id, p);
    expect(second.replayed).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(await count(p.clientRequestId)).toBe(1);
  });

  it("concurrent identical submissions create exactly one record", async () => {
    const id = await releasedJob();
    const p = payload();
    const results = await Promise.all([recordLabour(operator, id, p), recordLabour(operator, id, p), recordLabour(operator, id, p)]);
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await count(p.clientRequestId)).toBe(1);
  });

  it("a replay still succeeds after the job has been completed", async () => {
    const id = await releasedJob();
    const p = payload();
    await recordLabour(operator, id, p);
    await completeJob(prodMgr, id);
    const again = await recordLabour(operator, id, p);
    expect(again.replayed).toBe(true);
  });

  it("rejects reuse of a clientRequestId for different data or a different job", async () => {
    const id = await releasedJob();
    const other = await releasedJob();
    const p = payload();
    await recordLabour(operator, id, p);
    await expect(recordLabour(operator, id, { ...p, hours: 3 })).rejects.toBeInstanceOf(ConflictError);
    await expect(recordLabour(operator, other, p)).rejects.toBeInstanceOf(ConflictError);
  });

  it("the same clientRequestId in two different organizations is independent (unique per org)", async () => {
    const idA = await releasedJob();
    const pB = (await productWithActiveBom(ownerB, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
    const jobB = (await createJob(ownerB, { branchId: orgB.branchId, productItemId: pB, plannedQty: 1 })) as Record<string, any>;
    await transitionJob(ownerB, jobB.id, { status: "released" });

    const shared = randomUUID();
    const a = await recordLabour(ownerA, idA, payload({ clientRequestId: shared }));
    const b = await recordLabour(ownerB, jobB.id, payload({ clientRequestId: shared }));
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(a.record.id).not.toBe(b.record.id);
  });

  it("only released or in-progress jobs accept labour", async () => {
    const planned = (await createJob(ownerA, { branchId: orgA.branchId, productItemId: productId, plannedQty: 1 })) as Record<string, any>;
    await expect(recordLabour(operator, planned.id, payload())).rejects.toBeInstanceOf(ConflictError);

    const held = await releasedJob();
    await transitionJob(prodMgr, held, { status: "on_hold", reason: "test" });
    await expect(recordLabour(operator, held, payload())).rejects.toBeInstanceOf(ConflictError);

    const done = await releasedJob();
    await recordLabour(operator, done, payload());
    await completeJob(prodMgr, done);
    await expect(recordLabour(operator, done, payload())).rejects.toBeInstanceOf(ConflictError);
  });

  it("validates hours, rate, currency and clientRequestId", async () => {
    const id = await releasedJob();
    for (const bad of [
      payload({ hours: 0 }),
      payload({ hours: 25 }),
      payload({ hours: 1.234 }),
      payload({ rate: -1 }),
      payload({ rateCurrency: "XXX" }),
      payload({ clientRequestId: "not-a-uuid" }),
      { hours: 1, rate: 1, rateCurrency: "USD" },
    ]) {
      await expect(recordLabour(operator, id, bad)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("capabilities: operators and managers may record; viewer, finance and inventory may not", async () => {
    const id = await releasedJob();
    await expect(recordLabour(operator, id, payload())).resolves.toBeTruthy();
    await expect(recordLabour(prodMgr, id, payload())).resolves.toBeTruthy();
    for (const s of [viewer, finance, inventoryMgr]) {
      await expect(recordLabour(s, id, payload())).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("the response hides the rate from callers without cost:read", async () => {
    const id = await releasedJob();
    const asOperator = await recordLabour(operator, id, payload());
    expect("rate" in asOperator.record).toBe(false);
    const asManager = await recordLabour(prodMgr, id, payload());
    expect(String(asManager.record.rate)).toBe("4");
    expect(asManager.record.rateCurrency).toBe("USD");
  });

  it("hours are always attributed to the caller, never someone else", async () => {
    const id = await releasedJob();
    const res = await recordLabour(operator, id, payload({ userId: "00000000-0000-0000-0000-000000000000" }));
    expect(res.record.userId).toBe(operator.userId);
  });

  it("branch and tenant isolation: other branch / other org see 'not found'", async () => {
    const id = await releasedJob();
    await expect(recordLabour(prodMgr2, id, payload())).rejects.toBeInstanceOf(NotFoundError);
    await expect(recordLabour(ownerB, id, payload())).rejects.toBeInstanceOf(NotFoundError);
  });
});
