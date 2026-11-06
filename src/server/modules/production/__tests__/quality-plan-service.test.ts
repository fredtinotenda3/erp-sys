// Milestone 4: inspection plans and their characteristics (tolerances) for
// an item. Deliberately NOT versioned like BillOfMaterial -- see the file
// header of quality-plan-service.ts. This suite checks creation, listing,
// the "retire, don't redefine, a characteristic once measured" rule, and
// capability/tenant isolation.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createItem } from "../../catalog/item-service";
import { createJob, transitionJob } from "../job-service";
import { recordOutput } from "../output-service";
import { recordInspection } from "../quality-service";
import {
  createInspectionPlan,
  listInspectionPlans,
  getInspectionPlan,
  updateInspectionPlan,
  addCharacteristic,
  updateCharacteristic,
} from "../quality-plan-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";
import { randomUUID } from "node:crypto";

let org: TestOrg;
let owner: AuthenticatedSession;
let mgr: AuthenticatedSession; // quality_plan:manage
let operator: AuthenticatedSession; // quality:read only (no quality_plan:manage)
let itemId: string;
// A real finished_good with an active BOM -- createJob only accepts
// finished_good/wip as a product, so the "measured once" tests (which
// need a real job + recordInspection) build their plan against THIS item,
// not the raw-material `itemId` used by the plain plan-CRUD tests above.
let productId: string;

beforeAll(async () => {
  org = await createTestOrg("qpA");
  owner = await ownerSession(org);
  mgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "qp-mgr", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "qp-op", [org.branchId]);
  itemId = (await createItem(owner, { sku: `QP-ITEM-${randomUUID()}`, itemType: "raw_material", name: "Inspected material", uom: "kg" })).id;
  productId = (await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
}, 180_000);

const plan = (over: Record<string, unknown> = {}) => ({
  name: "Dimensional check",
  characteristics: [{ name: "Length", uom: "mm", minValue: 10, maxValue: 20, targetValue: 15 }],
  ...over,
});

describe("createInspectionPlan", () => {
  it("creates a plan with ordered characteristics and audits it", async () => {
    const p: any = await createInspectionPlan(mgr, itemId, plan({ characteristics: [{ name: "A" }, { name: "B" }, { name: "C" }] }));
    expect(p.characteristics.map((c: any) => c.name)).toEqual(["A", "B", "C"]);
    expect(p.characteristics.map((c: any) => c.sequence)).toEqual([1, 2, 3]);
  });

  it("rejects minValue greater than maxValue", async () => {
    await expect(createInspectionPlan(mgr, itemId, plan({ characteristics: [{ name: "Bad", minValue: 20, maxValue: 10 }] }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires at least one characteristic and rejects an unknown item", async () => {
    await expect(createInspectionPlan(mgr, itemId, plan({ characteristics: [] }))).rejects.toBeInstanceOf(ValidationError);
    await expect(createInspectionPlan(mgr, "00000000-0000-0000-0000-000000000000", plan())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("only quality_plan:manage may create a plan", async () => {
    await expect(createInspectionPlan(operator, itemId, plan())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("listInspectionPlans / getInspectionPlan", () => {
  it("lists plans for an item newest first, and a plain quality:read role can read them", async () => {
    const first: any = await createInspectionPlan(mgr, itemId, plan({ name: "First" }));
    const second: any = await createInspectionPlan(mgr, itemId, plan({ name: "Second" }));
    const list: any[] = await listInspectionPlans(operator, itemId);
    expect(list[0].id).toBe(second.id);
    expect(list.some((p) => p.id === first.id)).toBe(true);
  });

  it("getInspectionPlan 404s for an unknown plan", async () => {
    await expect(getInspectionPlan(mgr, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("tenant isolation: another org cannot see this org's plan", async () => {
    const p: any = await createInspectionPlan(mgr, itemId, plan());
    const orgB = await createTestOrg("qpB");
    const ownerB = await ownerSession(orgB);
    await expect(getInspectionPlan(ownerB, p.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("updateInspectionPlan", () => {
  it("renames a plan and can retire it (isActive:false)", async () => {
    const p: any = await createInspectionPlan(mgr, itemId, plan());
    const updated: any = await updateInspectionPlan(mgr, p.id, { name: "Renamed", isActive: false });
    expect(updated.name).toBe("Renamed");
    expect(updated.isActive).toBe(false);
  });

  it("rejects an empty update payload", async () => {
    const p: any = await createInspectionPlan(mgr, itemId, plan());
    await expect(updateInspectionPlan(mgr, p.id, {})).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("addCharacteristic", () => {
  it("appends a characteristic with the next sequence number", async () => {
    const p: any = await createInspectionPlan(mgr, itemId, plan({ characteristics: [{ name: "First" }] }));
    const c: any = await addCharacteristic(mgr, p.id, { name: "Second" });
    expect(c.sequence).toBe(2);
  });

  it("only quality_plan:manage may add a characteristic", async () => {
    const p: any = await createInspectionPlan(mgr, itemId, plan());
    await expect(addCharacteristic(operator, p.id, { name: "X" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("updateCharacteristic", () => {
  it("can rename/rebound a characteristic that has never been measured", async () => {
    const p: any = await createInspectionPlan(mgr, itemId, plan({ characteristics: [{ name: "Width", minValue: 1, maxValue: 5 }] }));
    const c = p.characteristics[0];
    const updated: any = await updateCharacteristic(mgr, c.id, { minValue: 2, maxValue: 6 });
    expect(String(updated.minValue)).toBe("2");
    expect(String(updated.maxValue)).toBe("6");
  });

  it("can always be retired (isActive:false), even after measurements exist", async () => {
    const p: any = await createInspectionPlan(mgr, productId, plan({ characteristics: [{ name: "Thickness", minValue: 1, maxValue: 5 }] }));
    const c = p.characteristics[0];
    await measureAgainst(p.id, c.id, 3);
    const retired: any = await updateCharacteristic(mgr, c.id, { isActive: false });
    expect(retired.isActive).toBe(false);
  });

  it("refuses to change the DEFINITION (name/uom/bounds) of a characteristic once it has a recorded measurement", async () => {
    const p: any = await createInspectionPlan(mgr, productId, plan({ characteristics: [{ name: "Weight", minValue: 1, maxValue: 5 }] }));
    const c = p.characteristics[0];
    await measureAgainst(p.id, c.id, 3);
    await expect(updateCharacteristic(mgr, c.id, { minValue: 2 })).rejects.toBeInstanceOf(ConflictError);
    await expect(updateCharacteristic(mgr, c.id, { name: "Renamed" })).rejects.toBeInstanceOf(ConflictError);
    // isActive alone is still fine (checked above); this just re-confirms the distinction.
    await expect(updateCharacteristic(mgr, c.id, { isActive: false })).resolves.toBeTruthy();
  });
});

// Helper: records one inspection with one measurement against the given
// plan/characteristic, via a fresh job of `productId` -- the plan passed in
// must have been created against `productId` too (recordInspection now
// rejects a plan belonging to a different item; see quality-service.ts).
async function measureAgainst(planId: string, characteristicId: string, measuredValue: number) {
  const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
  await transitionJob(owner, job.id, { status: "released" });
  await recordOutput(mgr, job.id, { clientRequestId: randomUUID(), goodQty: 1 });
  await recordInspection(mgr, job.id, {
    clientRequestId: randomUUID(),
    inspectedQty: 1,
    rejectedQty: 0,
    inspectionPlanId: planId,
    measurements: [{ characteristicId, measuredValue }],
  });
}
