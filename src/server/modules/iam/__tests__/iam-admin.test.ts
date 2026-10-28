// Authorization boundaries for the user / branch administration screens.
import { describe, expect, it } from "vitest";
import { createTestOrg, loginAs, ownerSession, testEmail, TEST_PASSWORD } from "./test-helpers";
import { createBranch, deactivateBranch, getBranchDetail, grantBranchAccess, listBranches, revokeBranchAccess } from "../branch-service";
import { createUser, deactivateUser, getUser, updateUserRole } from "../user-service";

async function org(label: string) {
  const o = await createTestOrg(label);
  const owner = await ownerSession(o);
  return { o, owner };
}
async function as(orgId: string, role: "OWNER_ADMIN" | "OPERATIONS_MANAGER" | "VIEWER", owner: Awaited<ReturnType<typeof ownerSession>>, branchIds: string[]) {
  const email = testEmail(role.toLowerCase());
  const user = await createUser(owner, { email, fullName: role, role, password: TEST_PASSWORD, branchIds });
  const { session } = await loginAs(orgId, email);
  return { user, session };
}

describe("user administration: privilege and branch boundaries", () => {
  it("never exposes a password hash through getUser", async () => {
    const { o, owner } = await org("iam-hash");
    const u = await as(o.organizationId, "VIEWER", owner, [o.branchId]);
    const detail = await getUser(owner, u.user.id);
    expect(JSON.stringify(detail)).not.toMatch(/password|hash|argon/i);
    expect(detail.branchAccess.map((b) => b.branchId)).toEqual([o.branchId]);
    expect(detail.implicitAllBranches).toBe(false);
    expect((await getUser(owner, owner.userId)).implicitAllBranches).toBe(true);
  });

  it("is org-scoped: another organization's user is not found", async () => {
    const a = await org("iam-a");
    const b = await org("iam-b");
    await expect(getUser(b.owner, a.owner.userId)).rejects.toThrow(/not found/);
    await expect(getUser(b.owner, "nope")).rejects.toThrow(/not found/);
    await expect(deactivateUser(b.owner, a.owner.userId)).rejects.toThrow(/not found/);
  });

  it("stops a manager from deactivating an owner, or minting one", async () => {
    const { o, owner } = await org("iam-escalate");
    const second = await as(o.organizationId, "OWNER_ADMIN", owner, []);
    const ops = await as(o.organizationId, "OPERATIONS_MANAGER", owner, [o.branchId]);
    await expect(deactivateUser(ops.session, second.user.id)).rejects.toThrow(/Only an OWNER_ADMIN can deactivate/);
    await expect(createUser(ops.session, { email: testEmail("x"), fullName: "x", role: "OWNER_ADMIN", password: TEST_PASSWORD })).rejects.toThrow(/Only an OWNER_ADMIN can assign/);
    await expect(updateUserRole(ops.session, ops.user.id, "OWNER_ADMIN")).rejects.toThrow(/does not have/);
    // An owner still can, and the last-owner protection still holds.
    expect((await deactivateUser(owner, second.user.id)).isActive).toBe(false);
    await expect(deactivateUser(owner, owner.userId)).rejects.toThrow(/last active OWNER_ADMIN/);
  });

  it("only lets a non-owner hand out branches they hold themselves", async () => {
    const { o, owner } = await org("iam-branches");
    const other = await createBranch(owner, { name: `Other ${Date.now()}` });
    const ops = await as(o.organizationId, "OPERATIONS_MANAGER", owner, [o.branchId]);
    const target = await as(o.organizationId, "VIEWER", owner, []);

    await expect(createUser(ops.session, { email: testEmail("y"), fullName: "y", role: "VIEWER", password: TEST_PASSWORD, branchIds: [other.id] })).rejects.toThrow(/branches you have access to/);
    await expect(grantBranchAccess(ops.session, { userId: target.user.id, branchId: other.id })).rejects.toThrow(/not found/i);
    await expect(revokeBranchAccess(ops.session, { userId: target.user.id, branchId: other.id })).rejects.toThrow(/not found/i);
    await grantBranchAccess(ops.session, { userId: target.user.id, branchId: o.branchId }); // own branch: fine
    expect((await getUser(owner, target.user.id)).branchAccess).toHaveLength(1);
    // Reading a user does not reveal grants on branches the caller cannot see.
    await grantBranchAccess(owner, { userId: target.user.id, branchId: other.id });
    expect((await getUser(ops.session, target.user.id)).branchAccess.map((b) => b.branchId)).toEqual([o.branchId]);
    expect((await getUser(owner, target.user.id)).branchAccess).toHaveLength(2);
  });
});

describe("branch administration: scope and lifecycle", () => {
  it("hides branches the caller has no grant for, on read and on deactivate", async () => {
    const { o, owner } = await org("br-scope");
    const hidden = await createBranch(owner, { name: `Hidden ${Date.now()}` });
    const ops = await as(o.organizationId, "OPERATIONS_MANAGER", owner, [o.branchId]);
    expect((await listBranches(ops.session)).map((b) => b.id)).toEqual([o.branchId]);
    await expect(getBranchDetail(ops.session, hidden.id)).rejects.toThrow(/not found/);
    await expect(deactivateBranch(ops.session, hidden.id)).rejects.toThrow(/not found/);
    expect((await getBranchDetail(owner, hidden.id)).isActive).toBe(true);
  });

  it("lists members (owners implicit, others by grant) and refuses to deactivate the last active branch", async () => {
    const { o, owner } = await org("br-members");
    const v = await as(o.organizationId, "VIEWER", owner, [o.branchId]);
    const detail = await getBranchDetail(owner, o.branchId);
    const byId = new Map(detail.members.map((m) => [m.id, m.access]));
    expect(byId.get(owner.userId)).toBe("implicit");
    expect(byId.get(v.user.id)).toBe("granted");
    expect(JSON.stringify(detail)).not.toMatch(/password|hash/i);

    await expect(deactivateBranch(owner, o.branchId)).rejects.toThrow(/last active branch/);
    const second = await createBranch(owner, { name: `Second ${Date.now()}` });
    expect((await deactivateBranch(owner, o.branchId)).isActive).toBe(false);
    await expect(deactivateBranch(owner, second.id)).rejects.toThrow(/last active branch/);
    await expect(getBranchDetail(owner, "not-a-uuid")).rejects.toThrow(/not found/);
  });

  it("is org-scoped", async () => {
    const a = await org("br-org-a");
    const b = await org("br-org-b");
    await expect(getBranchDetail(b.owner, a.o.branchId)).rejects.toThrow(/not found/);
    await expect(deactivateBranch(b.owner, a.o.branchId)).rejects.toThrow(/not found/);
  });
});
