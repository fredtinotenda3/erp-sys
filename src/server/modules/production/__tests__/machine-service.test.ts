// Milestone 4: the work-centre/machine register, downtime and maintenance.
// Same approach as every other production suite: real Postgres, fresh
// random org per top-level describe where isolation is under test, shared
// fixtures via beforeAll where it's just setup.
/* eslint-disable @typescript-eslint/no-explicit-any -- service return types are plain Prisma rows; tests read fields by name */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch, deactivateBranch } from "../../iam/branch-service";
import { listAuditLog } from "../../iam/audit-service";
import {
  createWorkCentre,
  listWorkCentres,
  getWorkCentre,
  updateWorkCentre,
  createMachine,
  listMachines,
  getMachine,
  updateMachine,
  openDowntime,
  closeDowntime,
  scheduleMaintenance,
  completeMaintenance,
} from "../machine-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { sessionWithRole } from "./production-helpers";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let branch2: string;
let prodMgr: AuthenticatedSession; // machine:manage
let invMgr: AuthenticatedSession; // machine:read only
let viewer: AuthenticatedSession; // machine:read only
let operator: AuthenticatedSession; // machine:read + machine_time:record, no manage

beforeAll(async () => {
  orgA = await createTestOrg("macA");
  orgB = await createTestOrg("macB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  branch2 = (await createBranch(ownerA, { name: "Second" })).id;
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "mac-pm", [orgA.branchId, branch2]);
  invMgr = await sessionWithRole(ownerA, orgA.organizationId, "INVENTORY_MANAGER", "mac-im", [orgA.branchId]);
  viewer = await sessionWithRole(ownerA, orgA.organizationId, "VIEWER", "mac-vw", [orgA.branchId]);
  operator = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_OPERATOR", "mac-op", [orgA.branchId]);
}, 180_000);

let wcCounter = 0;
async function workCentre(owner: AuthenticatedSession, branchId: string, over: Record<string, unknown> = {}) {
  wcCounter += 1;
  return createWorkCentre(owner, { branchId, code: `WC-${wcCounter}`, name: `Work Centre ${wcCounter}`, ...over });
}

let mCounter = 0;
async function machine(owner: AuthenticatedSession, workCentreId: string, over: Record<string, unknown> = {}) {
  mCounter += 1;
  return createMachine(owner, { workCentreId, code: `M-${mCounter}`, name: `Machine ${mCounter}`, ...over });
}

describe("work centres", () => {
  it("creates a work centre with an optional daily capacity and audits it", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId, { dailyCapacityMinutes: 480 });
    expect(wc.branchId).toBe(orgA.branchId);
    expect(wc.dailyCapacityMinutes).toBe(480);
    expect(wc.isActive).toBe(true);
    const entries = (await listAuditLog(ownerA, { entityType: "work_centre", entityId: wc.id })) as any[];
    expect(entries.some((e) => e.action === "create")).toBe(true);
  });

  it("dailyCapacityMinutes is optional and defaults to null (no guessed capacity)", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    expect(wc.dailyCapacityMinutes).toBeNull();
  });

  it("rejects a duplicate code within the same branch, but allows it in a different branch", async () => {
    wcCounter += 1;
    const code = `DUP-${wcCounter}`;
    await createWorkCentre(prodMgr, { branchId: orgA.branchId, code, name: "First" });
    await expect(createWorkCentre(prodMgr, { branchId: orgA.branchId, code, name: "Second" })).rejects.toBeInstanceOf(ConflictError);
    await expect(createWorkCentre(prodMgr, { branchId: branch2, code, name: "Other branch" })).resolves.toBeTruthy();
  });

  it("rejects adding a work centre to an inactive branch", async () => {
    // ownerA (OWNER_ADMIN): the new branch was just created and prodMgr
    // hasn't been granted access to it, so prodMgr would fail on branch
    // access before ever reaching the inactive-branch check this test is
    // isolating. OWNER_ADMIN has implicit access to every branch.
    const b = await createBranch(ownerA, { name: "ToDeactivate" });
    await deactivateBranch(ownerA, b.id);
    await expect(workCentre(ownerA, b.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("only machine:manage roles may create or update; machine:read roles may only list/view", async () => {
    await expect(workCentre(invMgr, orgA.branchId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(workCentre(viewer, orgA.branchId)).rejects.toBeInstanceOf(ForbiddenError);
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    await expect(listWorkCentres(invMgr)).resolves.toBeTruthy();
    await expect(listWorkCentres(viewer)).resolves.toBeTruthy();
    await expect(updateWorkCentre(invMgr, wc.id, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updateWorkCentre changes name/capacity/isActive and audits before/after", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId, { dailyCapacityMinutes: 100 });
    const updated: any = await updateWorkCentre(prodMgr, wc.id, { name: "Renamed", dailyCapacityMinutes: 200, isActive: false });
    expect(updated.name).toBe("Renamed");
    expect(updated.dailyCapacityMinutes).toBe(200);
    expect(updated.isActive).toBe(false);
    const entries = (await listAuditLog(ownerA, { entityType: "work_centre", entityId: wc.id })) as any[];
    const upd = entries.find((e) => e.action === "update");
    expect(upd.beforeValue.dailyCapacityMinutes).toBe(100);
    expect(upd.afterValue.dailyCapacityMinutes).toBe(200);
  });

  it("updateWorkCentre rejects an empty payload", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    await expect(updateWorkCentre(prodMgr, wc.id, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("getWorkCentre includes its machines", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m1: any = await machine(prodMgr, wc.id);
    const got: any = await getWorkCentre(prodMgr, wc.id);
    expect(got.machines.map((x: any) => x.id)).toContain(m1.id);
  });

  it("branch and tenant isolation: another branch's manager and another org both see 'not found'", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const otherBranchMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "mac-ob", [branch2]);
    await expect(getWorkCentre(otherBranchMgr, wc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getWorkCentre(ownerB, wc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateWorkCentre(ownerB, wc.id, { name: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("machines", () => {
  it("creates a machine under a work centre, defaulting to available/active", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    expect(m.status).toBe("available");
    expect(m.isActive).toBe(true);
  });

  it("rejects an unknown or inaccessible workCentreId, and an inactive work centre", async () => {
    await expect(machine(prodMgr, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(ValidationError);
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    await updateWorkCentre(prodMgr, wc.id, { isActive: false });
    await expect(machine(prodMgr, wc.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a duplicate machine code within the same work centre, but allows it in a different one", async () => {
    const wc1: any = await workCentre(prodMgr, orgA.branchId);
    const wc2: any = await workCentre(prodMgr, orgA.branchId);
    mCounter += 1;
    const code = `DUPM-${mCounter}`;
    await createMachine(prodMgr, { workCentreId: wc1.id, code, name: "First" });
    await expect(createMachine(prodMgr, { workCentreId: wc1.id, code, name: "Second" })).rejects.toBeInstanceOf(ConflictError);
    await expect(createMachine(prodMgr, { workCentreId: wc2.id, code, name: "Other WC" })).resolves.toBeTruthy();
  });

  it("listMachines filters by status and by work centre", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m1: any = await machine(prodMgr, wc.id);
    await updateMachine(prodMgr, m1.id, { status: "in_use" });
    const inUse: any[] = await listMachines(prodMgr, { workCentreId: wc.id, status: "in_use" });
    expect(inUse.map((x) => x.id)).toContain(m1.id);
    const available: any[] = await listMachines(prodMgr, { workCentreId: wc.id, status: "available" });
    expect(available.map((x) => x.id)).not.toContain(m1.id);
  });

  it("getMachine includes open/recent downtime and maintenance history", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const dt: any = await openDowntime(prodMgr, m.id, { category: "breakdown", reason: "Belt snapped" });
    const got: any = await getMachine(prodMgr, m.id);
    expect(got.openDowntime.id).toBe(dt.id);
    expect(got.recentDowntime.some((d: any) => d.id === dt.id)).toBe(true);
  });

  it("updateMachine cannot set status directly to 'down' -- only the downtime endpoints may", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await expect(updateMachine(prodMgr, m.id, { status: "down" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("updateMachine blocks any status change away from 'down' while a downtime record is still open", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await openDowntime(prodMgr, m.id, { category: "breakdown", reason: "Motor failure" });
    await expect(updateMachine(prodMgr, m.id, { status: "available" })).rejects.toBeInstanceOf(ConflictError);
    await expect(updateMachine(prodMgr, m.id, { status: "maintenance" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("updateMachine allows ordinary available <-> in_use transitions and retiring a machine", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await updateMachine(prodMgr, m.id, { status: "in_use" });
    const back: any = await updateMachine(prodMgr, m.id, { status: "available" });
    expect(back.status).toBe("available");
    const retired: any = await updateMachine(prodMgr, m.id, { status: "retired", isActive: false });
    expect(retired.status).toBe("retired");
    expect(retired.isActive).toBe(false);
  });

  it("only machine:manage roles may create or update a machine", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    await expect(machine(invMgr, wc.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(machine(viewer, wc.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(machine(operator, wc.id)).rejects.toBeInstanceOf(ForbiddenError);
    const m: any = await machine(prodMgr, wc.id);
    await expect(updateMachine(invMgr, m.id, { status: "in_use" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("branch and tenant isolation on machines", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const otherBranchMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "mac-ob2", [branch2]);
    await expect(getMachine(otherBranchMgr, m.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMachine(ownerB, m.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("downtime", () => {
  it("opening downtime sets the machine to 'down' and audits with the reason", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const dt: any = await openDowntime(prodMgr, m.id, { category: "no_material", reason: "Out of resin" });
    const got: any = await getMachine(prodMgr, m.id);
    expect(got.status).toBe("down");
    const entries = (await listAuditLog(ownerA, { entityType: "machine_downtime_record", entityId: dt.id })) as any[];
    expect(entries[0].reason).toBe("Out of resin");
  });

  it("a machine cannot have two open downtime records at once", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await openDowntime(prodMgr, m.id, { category: "breakdown", reason: "First issue" });
    await expect(openDowntime(prodMgr, m.id, { category: "other", reason: "Second issue" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("a retired machine cannot be marked down", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await updateMachine(prodMgr, m.id, { status: "retired" });
    await expect(openDowntime(prodMgr, m.id, { category: "breakdown", reason: "Doesn't matter" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("reason must be at least 3 characters", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await expect(openDowntime(prodMgr, m.id, { category: "breakdown", reason: "x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("closing downtime restores the machine to available and appends any notes to the reason", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const dt: any = await openDowntime(prodMgr, m.id, { category: "breakdown", reason: "Belt snapped" });
    const closed: any = await closeDowntime(prodMgr, m.id, dt.id, { notes: "Replaced belt" });
    expect(closed.endedAt).toBeTruthy();
    expect(closed.reason).toBe("Belt snapped — Replaced belt");
    const got: any = await getMachine(prodMgr, m.id);
    expect(got.status).toBe("available");
  });

  it("closing an already-closed downtime record is rejected", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const dt: any = await openDowntime(prodMgr, m.id, { category: "breakdown", reason: "Belt snapped" });
    await closeDowntime(prodMgr, m.id, dt.id);
    await expect(closeDowntime(prodMgr, m.id, dt.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("only machine:manage roles may open or close downtime", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await expect(openDowntime(invMgr, m.id, { category: "breakdown", reason: "x-y-z" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openDowntime(viewer, m.id, { category: "breakdown", reason: "x-y-z" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("maintenance", () => {
  it("scheduling scheduled maintenance requires scheduledAt; unscheduled does not", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await expect(scheduleMaintenance(prodMgr, m.id, { type: "scheduled" })).rejects.toBeInstanceOf(ValidationError);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const rec: any = await scheduleMaintenance(prodMgr, m.id, { type: "scheduled", scheduledAt: future });
    expect(rec.completedAt).toBeNull();
    const unscheduled: any = await scheduleMaintenance(prodMgr, m.id, { type: "unscheduled", notes: "Done on the spot" });
    expect(unscheduled.scheduledAt).toBeNull();
  });

  it("scheduling maintenance does not by itself change the machine's status", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await scheduleMaintenance(prodMgr, m.id, { type: "unscheduled" });
    const got: any = await getMachine(prodMgr, m.id);
    expect(got.status).toBe("available");
  });

  it("completing maintenance returns the machine to available ONLY if it was parked in 'maintenance'", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const rec: any = await scheduleMaintenance(prodMgr, m.id, { type: "unscheduled" });
    await updateMachine(prodMgr, m.id, { status: "maintenance" });
    const completed: any = await completeMaintenance(prodMgr, m.id, rec.id, { notes: "All good" });
    expect(completed.completedAt).toBeTruthy();
    expect(completed.notes).toContain("All good");
    const got: any = await getMachine(prodMgr, m.id);
    expect(got.status).toBe("available");
  });

  it("completing maintenance leaves the machine's status alone if it was never parked in 'maintenance'", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const rec: any = await scheduleMaintenance(prodMgr, m.id, { type: "unscheduled" });
    await updateMachine(prodMgr, m.id, { status: "in_use" });
    await completeMaintenance(prodMgr, m.id, rec.id);
    const got: any = await getMachine(prodMgr, m.id);
    expect(got.status).toBe("in_use");
  });

  it("completing an already-completed maintenance record is rejected", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    const rec: any = await scheduleMaintenance(prodMgr, m.id, { type: "unscheduled" });
    await completeMaintenance(prodMgr, m.id, rec.id);
    await expect(completeMaintenance(prodMgr, m.id, rec.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("only machine:manage roles may schedule or complete maintenance", async () => {
    const wc: any = await workCentre(prodMgr, orgA.branchId);
    const m: any = await machine(prodMgr, wc.id);
    await expect(scheduleMaintenance(operator, m.id, { type: "unscheduled" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
