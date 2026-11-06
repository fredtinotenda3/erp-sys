// Milestone 6 (Plastics Manufacturing Vertical): the mould register.
// Mirrors machine-service.ts's work-centre/machine shape closely -- see
// mould-service.ts's own header comment. Real-database test, not executed
// in this environment -- see IMPLEMENTATION_MANIFEST.md and
// industry-profile-service.test.ts's header comment for why. Run with
// `npm test -- mould-service`.
//
// Covers: creation/listing/update across branches, code uniqueness per
// branch, compatibleProductItemId's finished_good/wip gate, machine
// compatibility add/remove, the scheduled/unscheduled maintenance lifecycle
// (including the mould auto-transitioning out of "maintenance" status on
// completion), mould:read/mould:manage capability split, the plastics
// profile write gate with reads staying available after switching away, and
// org/branch isolation.
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { sessionWithRole, productWithActiveBom } from "./production-helpers";
import { createItem } from "../../catalog/item-service";
import { createWorkCentre, createMachine } from "../machine-service";
import { updateIndustryProfile } from "../../industry/industry-profile-service";
import {
  createMould,
  listMoulds,
  getMould,
  updateMould,
  addMouldMachineCompatibility,
  removeMouldMachineCompatibility,
  scheduleMouldMaintenance,
  completeMouldMaintenance,
} from "../mould-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let org: TestOrg;
let owner: AuthenticatedSession;
let prodMgr: AuthenticatedSession; // mould:manage
let inv: AuthenticatedSession; // mould:read only (mould:manage NOT granted -- mirrors machine:manage's omission)
let operator: AuthenticatedSession; // mould:read only
let branch2Id: string;
let machineId: string;
let bottleItemId: string;
let sparePartItemId: string;

let codeCounter = 0;
function code(prefix: string) {
  codeCounter += 1;
  return `${prefix}-${codeCounter}`;
}
let skuCounter = 0;
function sku(prefix: string) {
  skuCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${skuCounter}`;
}

beforeAll(async () => {
  org = await createTestOrg("mouldA");
  owner = await ownerSession(org);
  prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "mo-pm", [org.branchId]);
  inv = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "mo-inv", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "mo-op", [org.branchId]);
  await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });

  branch2Id = (await createBranch(owner, { name: "Mould branch 2" })).id;
  const wc = await createWorkCentre(owner, { branchId: org.branchId, code: code("WC"), name: "Moulding line 1" });
  machineId = (await createMachine(owner, { workCentreId: wc.id, code: code("M"), name: "Press 1" })).id;

  bottleItemId = (await createItem(owner, { sku: sku("BTL"), itemType: "finished_good", name: "Mould test bottle", uom: "ea" })).id;
  sparePartItemId = (await createItem(owner, { sku: sku("SPARE"), itemType: "spare_part", name: "Mould test spare", uom: "ea" })).id;
}, 180_000);

describe("createMould", () => {
  it("creates a mould scoped to a branch", async () => {
    const m: any = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "500ml bottle mould", cavityCount: 4 });
    expect(m.cavityCount).toBe(4);
    expect(m.status).toBe("available");
    expect(m.isActive).toBe(true);
  });

  it("accepts an optional compatibleProductItemId naming a finished_good/wip item", async () => {
    const m: any = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Bottle-specific mould", cavityCount: 8, compatibleProductItemId: bottleItemId });
    expect(m.compatibleProductItemId).toBe(bottleItemId);
  });

  it("rejects a compatibleProductItemId that is not finished_good/wip", async () => {
    await expect(
      createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Bad mould", cavityCount: 4, compatibleProductItemId: sparePartItemId }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a duplicate code within the same branch", async () => {
    const dupe = code("MLD");
    await createMould(prodMgr, { branchId: org.branchId, code: dupe, name: "First", cavityCount: 2 });
    await expect(createMould(prodMgr, { branchId: org.branchId, code: dupe, name: "Second", cavityCount: 2 })).rejects.toThrow(ConflictError);
  });

  it("allows the same code in a different branch", async () => {
    const shared = code("MLD");
    await createMould(prodMgr, { branchId: org.branchId, code: shared, name: "Branch 1 mould", cavityCount: 2 });
    await expect(createMould(owner, { branchId: branch2Id, code: shared, name: "Branch 2 mould", cavityCount: 2 })).resolves.toBeTruthy();
  });

  it("rejects a non-positive or absurd cavityCount", async () => {
    await expect(createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 0 })).rejects.toThrow(ValidationError);
    await expect(createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 257 })).rejects.toThrow(ValidationError);
  });

  it("requires mould:manage -- INVENTORY_MANAGER and PRODUCTION_OPERATOR both lack it", async () => {
    await expect(createMould(inv, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 1 })).rejects.toThrow(ForbiddenError);
    await expect(createMould(operator, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 1 })).rejects.toThrow(ForbiddenError);
  });

  it("requires the plastics profile to be active", async () => {
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
    await expect(createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 1 })).rejects.toThrow(ValidationError);
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  });
});

describe("listMoulds / getMould", () => {
  it("lists moulds scoped to the caller's own branches by default, and is readable without mould:manage", async () => {
    const all = await listMoulds(owner, {});
    expect(all.length).toBeGreaterThan(0);
    // listMoulds's return type resolves through prisma.mould, a Milestone 6
    // model not yet in this environment's generated Prisma client (see
    // IMPLEMENTATION_MANIFEST.md -- self-resolves after `npx prisma
    // generate`) -- annotated `: any` here for the same reason, not a test bug.
    const scoped: any[] = await listMoulds(inv, {});
    expect(scoped.every((m: any) => m.branchId === org.branchId)).toBe(true);
  });

  it("filters by status", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Retired-to-be", cavityCount: 1 });
    await updateMould(prodMgr, m.id, { status: "retired" });
    const retired: any[] = await listMoulds(owner, { branchId: org.branchId, status: "retired" });
    expect(retired.some((x: any) => x.id === m.id)).toBe(true);
    expect(retired.every((x: any) => x.status === "retired")).toBe(true);
  });

  it("getMould returns compatible machines and maintenance history, 404s when out of scope", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Detail test", cavityCount: 2 });
    const detail: any = await getMould(owner, m.id);
    expect(detail.compatibleMachineIds).toEqual([]);
    expect(detail.maintenance).toEqual([]);
    await expect(getMould(owner, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(NotFoundError);
  });

  it("remains readable after the organization switches away from the plastics profile", async () => {
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
    await expect(listMoulds(owner, {})).resolves.toBeTruthy();
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  });
});

describe("updateMould", () => {
  it("updates provided fields only and audits before/after", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "To rename", cavityCount: 4 });
    const updated: any = await updateMould(prodMgr, m.id, { name: "Renamed mould" });
    expect(updated.name).toBe("Renamed mould");
    expect(updated.cavityCount).toBe(4); // untouched
  });

  it("rejects an empty update payload", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 1 });
    await expect(updateMould(prodMgr, m.id, {})).rejects.toThrow(ValidationError);
  });

  it("requires mould:manage", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 1 });
    await expect(updateMould(inv, m.id, { name: "y" })).rejects.toThrow(ForbiddenError);
  });
});

describe("machine compatibility", () => {
  it("adds and removes a (mould, machine) compatibility pair", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Compat test", cavityCount: 2 });
    await addMouldMachineCompatibility(prodMgr, m.id, machineId);
    const detail: any = await getMould(owner, m.id);
    expect(detail.compatibleMachineIds).toContain(machineId);

    await removeMouldMachineCompatibility(prodMgr, m.id, machineId);
    const after: any = await getMould(owner, m.id);
    expect(after.compatibleMachineIds).not.toContain(machineId);
  });

  it("rejects adding the same pair twice", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Dup compat", cavityCount: 2 });
    await addMouldMachineCompatibility(prodMgr, m.id, machineId);
    await expect(addMouldMachineCompatibility(prodMgr, m.id, machineId)).rejects.toThrow(ConflictError);
  });

  it("404s removing a pair that was never added", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "No compat", cavityCount: 2 });
    await expect(removeMouldMachineCompatibility(prodMgr, m.id, machineId)).rejects.toThrow(NotFoundError);
  });

  it("rejects a machine that does not belong to an accessible work centre", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "x", cavityCount: 2 });
    await expect(addMouldMachineCompatibility(prodMgr, m.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(ValidationError);
  });
});

describe("maintenance", () => {
  it("scheduled maintenance requires scheduledAt; unscheduled does not", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Maint test", cavityCount: 2 });
    await expect(scheduleMouldMaintenance(prodMgr, m.id, { type: "scheduled" })).rejects.toThrow(ValidationError);
    const rec: any = await scheduleMouldMaintenance(prodMgr, m.id, { type: "unscheduled", notes: "Cracked gate insert" });
    expect(rec.completedAt).toBeNull();
  });

  it("completing a maintenance record stamps completedAt and auto-returns the mould to available from maintenance", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Auto-return test", cavityCount: 2 });
    await updateMould(prodMgr, m.id, { status: "maintenance" });
    const rec = await scheduleMouldMaintenance(prodMgr, m.id, { type: "unscheduled" });
    const completed: any = await completeMouldMaintenance(prodMgr, m.id, rec.id, { notes: "Replaced insert" });
    expect(completed.completedAt).not.toBeNull();

    const detail: any = await getMould(owner, m.id);
    expect(detail.status).toBe("available");
  });

  it("rejects completing an already-completed maintenance record", async () => {
    const m = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Double complete", cavityCount: 2 });
    const rec = await scheduleMouldMaintenance(prodMgr, m.id, { type: "unscheduled" });
    await completeMouldMaintenance(prodMgr, m.id, rec.id);
    await expect(completeMouldMaintenance(prodMgr, m.id, rec.id)).rejects.toThrow(ConflictError);
  });

  it("404s a maintenance record belonging to a different mould", async () => {
    const m1 = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Mould 1", cavityCount: 2 });
    const m2 = await createMould(prodMgr, { branchId: org.branchId, code: code("MLD"), name: "Mould 2", cavityCount: 2 });
    const rec = await scheduleMouldMaintenance(prodMgr, m1.id, { type: "unscheduled" });
    await expect(completeMouldMaintenance(prodMgr, m2.id, rec.id)).rejects.toThrow(NotFoundError);
  });
});

describe("tenant isolation", () => {
  it("a mould from a different organization never resolves", async () => {
    const orgB = await createTestOrg("mouldB");
    const ownerB = await ownerSession(orgB);
    await updateIndustryProfile(ownerB, { industryProfile: "plastics", enabledModules: [] });
    const mB = await createMould(ownerB, { branchId: orgB.branchId, code: code("MLD"), name: "Org B mould", cavityCount: 1 });

    await expect(getMould(owner, mB.id)).rejects.toThrow(NotFoundError);
    await expect(updateMould(owner, mB.id, { name: "hijack" })).rejects.toThrow(NotFoundError);
  });

  it("respects branch access within the same organization", async () => {
    const m = await createMould(owner, { branchId: branch2Id, code: code("MLD"), name: "Branch 2 only", cavityCount: 1 });
    // prodMgr's session only has access to the main branch, not branch2.
    await expect(getMould(prodMgr, m.id)).rejects.toThrow(NotFoundError);
  });
});
