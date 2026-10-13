/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { listAuditLog } from "../../iam/audit-service";
import { createCustomer, updateCustomer } from "../../customers/customer-service";
import { createJob, updateJob, transitionJob, completeJob } from "../job-service";
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
let productId: string;

const newJob = async (extra: Record<string, unknown> = {}) =>
  ((await createJob(ownerA, { branchId: orgA.branchId, productItemId: productId, plannedQty: 4, ...extra })) as any).id as string;

beforeAll(async () => {
  orgA = await createTestOrg("juA");
  orgB = await createTestOrg("juB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  const branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
  prodMgr2 = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm2", [branch2]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "op", [orgA.branchId]);
  productId = (await productWithActiveBom(ownerA, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
}, 180_000);

describe("updateJob", () => {
  it("edits schedule, customer and quote, and audits before/after", async () => {
    const id = await newJob();
    const customer = await createCustomer(ownerA, { name: "Edit Customer" });
    const v = (await updateJob(prodMgr, id, {
      plannedStart: "2026-11-01", plannedEnd: "2026-11-10", customerId: customer.id, quotedAmount: 250, quotedCurrency: "USD",
    })) as any;
    expect(v.customerId).toBe(customer.id);
    expect(String(v.quotedAmount)).toBe("250");
    const entries = (await listAuditLog(ownerA, { entityType: "production_job", entityId: id })) as any[];
    const upd = entries.find((e) => e.action === "update");
    expect(upd.afterValue.quotedCurrency).toBe("USD");
    expect(upd.beforeValue.quotedAmount).toBeNull();
  });

  it("the quote can be cleared, but only as a pair", async () => {
    const id = await newJob({ quotedAmount: 100, quotedCurrency: "USD" });
    await expect(updateJob(prodMgr, id, { quotedAmount: null })).rejects.toBeInstanceOf(ValidationError);
    const v = (await updateJob(prodMgr, id, { quotedAmount: null, quotedCurrency: null })) as any;
    expect(v.quotedAmount).toBeNull();
    await expect(updateJob(prodMgr, id, { quotedAmount: 50 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates dates, customers and currency", async () => {
    const id = await newJob({ plannedStart: "2026-11-05" });
    await expect(updateJob(prodMgr, id, { plannedEnd: "2026-11-01" })).rejects.toBeInstanceOf(ValidationError);
    const dormant = await createCustomer(ownerA, { name: "Dormant" });
    await updateCustomer(ownerA, dormant.id, { status: "inactive" });
    await expect(updateJob(prodMgr, id, { customerId: dormant.id })).rejects.toBeInstanceOf(ValidationError);
    const foreign = await createCustomer(ownerB, { name: "Foreign" });
    await expect(updateJob(prodMgr, id, { customerId: foreign.id })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateJob(prodMgr, id, { quotedAmount: 1, quotedCurrency: "XXX" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateJob(prodMgr, id, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("product, quantity and BOM cannot be edited (unknown fields are rejected, not ignored)", async () => {
    const id = await newJob();
    await expect(updateJob(prodMgr, id, { plannedQty: 99, plannedStart: "2026-11-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateJob(prodMgr, id, { productItemId: productId })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateJob(prodMgr, id, { bomId: productId })).rejects.toBeInstanceOf(ValidationError);
  });

  it("a finished job can no longer be edited", async () => {
    const id = await newJob();
    await transitionJob(ownerA, id, { status: "released" });
    await transitionJob(ownerA, id, { status: "in_progress" });
    await completeJob(ownerA, id);
    await expect(updateJob(prodMgr, id, { quotedAmount: 1, quotedCurrency: "USD" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("capability, branch and tenant isolation", async () => {
    const id = await newJob();
    await expect(updateJob(operator, id, { plannedStart: "2026-11-01" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateJob(prodMgr2, id, { plannedStart: "2026-11-01" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateJob(ownerB, id, { plannedStart: "2026-11-01" })).rejects.toBeInstanceOf(NotFoundError);
  });
});
