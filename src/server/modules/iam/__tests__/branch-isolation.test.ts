import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "./test-helpers";
import { createBranch, grantBranchAccess, listBranches, revokeBranchAccess } from "../branch-service";
import { createUser } from "../user-service";
import { hasBranchAccess, assertBranchAccess } from "../../../shared/authz";
import { ForbiddenError } from "../../../shared/errors";

describe("branch isolation (within a single organization)", () => {
  it("OWNER_ADMIN has implicit access to every branch, with zero explicit grant rows", async () => {
    const org = await createTestOrg("ownerImplicit");
    const owner = await ownerSession(org);
    const secondBranch = await createBranch(owner, { name: "Second Branch" });

    // Re-login to get a fresh session built from the current DB state —
    // proves the implicit access is role-based (computed in
    // shared/authz.ts), not something baked into the first session.
    const refreshed = await ownerSession(org);
    expect(hasBranchAccess(refreshed, secondBranch.id)).toBe(true);
    expect(() => assertBranchAccess(refreshed, secondBranch.id)).not.toThrow();

    const visible = await listBranches(refreshed);
    expect(visible.some((b) => b.id === secondBranch.id)).toBe(true);
  });

  it("a non-owner role sees only branches it has been explicitly granted — no fallback to org-wide access", async () => {
    const org = await createTestOrg("explicitGrant");
    const owner = await ownerSession(org);

    const branchX = await createBranch(owner, { name: "Branch X" });
    const branchY = await createBranch(owner, { name: "Branch Y" });

    const viewerEmail = testEmail("viewer");
    await createUser(owner, {
      email: viewerEmail,
      fullName: "Viewer User",
      role: "VIEWER",
      password: TEST_PASSWORD,
      branchIds: [branchX.id], // explicit grant to X only — NOT Y
    });

    const { session: viewerSession } = await loginAs(org.organizationId, viewerEmail);

    expect(hasBranchAccess(viewerSession, branchX.id)).toBe(true);
    expect(hasBranchAccess(viewerSession, branchY.id)).toBe(false);
    expect(() => assertBranchAccess(viewerSession, branchY.id)).toThrow(ForbiddenError);

    const visibleToViewer = await listBranches(viewerSession);
    expect(visibleToViewer.map((b) => b.id)).toEqual([branchX.id]);
  });

  it("revoking branch access removes it from what the user can see on their next session", async () => {
    const org = await createTestOrg("revoke");
    const owner = await ownerSession(org);
    const branch = await createBranch(owner, { name: "Revocable Branch" });

    const email = testEmail("revokee");
    const user = await createUser(owner, {
      email,
      fullName: "Revokee",
      role: "VIEWER",
      password: TEST_PASSWORD,
      branchIds: [branch.id],
    });

    const first = await loginAs(org.organizationId, email);
    expect(hasBranchAccess(first.session, branch.id)).toBe(true);

    const revoked = await revokeBranchAccess(owner, { userId: user.id, branchId: branch.id });
    expect(revoked).toBe(true);

    const second = await loginAs(org.organizationId, email);
    expect(hasBranchAccess(second.session, branch.id)).toBe(false);
  });

  it("granting the same branch access twice is idempotent, not an error", async () => {
    const org = await createTestOrg("idempotentGrant");
    const owner = await ownerSession(org);
    const branch = await createBranch(owner, { name: "Idempotent Branch" });
    const email = testEmail("idempotent-grantee");
    const user = await createUser(owner, {
      email,
      fullName: "Idempotent Grantee",
      role: "VIEWER",
      password: TEST_PASSWORD,
    });

    await grantBranchAccess(owner, { userId: user.id, branchId: branch.id });
    await expect(grantBranchAccess(owner, { userId: user.id, branchId: branch.id })).resolves.not.toThrow();
  });

  it("revoking access that was never granted is reported as not-found, not silently ignored", async () => {
    const org = await createTestOrg("revokeNoop");
    const owner = await ownerSession(org);
    const branch = await createBranch(owner, { name: "Never Granted" });
    const email = testEmail("never-granted");
    const user = await createUser(owner, { email, fullName: "Never Granted", role: "VIEWER", password: TEST_PASSWORD });

    const revoked = await revokeBranchAccess(owner, { userId: user.id, branchId: branch.id });
    expect(revoked).toBe(false);
  });

  it("a PRODUCTION_OPERATOR cannot create branches — a capability check independent of branch access", async () => {
    const org = await createTestOrg("operatorCap");
    const owner = await ownerSession(org);
    const email = testEmail("operator");
    await createUser(owner, { email, fullName: "Operator", role: "PRODUCTION_OPERATOR", password: TEST_PASSWORD });

    const { session } = await loginAs(org.organizationId, email);
    await expect(createBranch(session, { name: "Should Not Be Created" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
