import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, testEmail, TEST_PASSWORD } from "./test-helpers";
import { createBranch, listBranches } from "../branch-service";
import { createUser, listUsers } from "../user-service";
import { listAuditLog } from "../audit-service";
import { login } from "../session-service";
import { UnauthorizedError, ValidationError } from "../../../shared/errors";

describe("tenant isolation (cross-organization)", () => {
  it("org A cannot see org B's branches, even as OWNER_ADMIN", async () => {
    const orgA = await createTestOrg("tenantA");
    const orgB = await createTestOrg("tenantB");

    await createBranch(await ownerSession(orgB), { name: "B-Only-Branch" });

    const branchesVisibleToA = await listBranches(await ownerSession(orgA));
    expect(branchesVisibleToA.every((b) => b.orgId === orgA.organizationId)).toBe(true);
    expect(branchesVisibleToA.some((b) => b.name === "B-Only-Branch")).toBe(false);
  });

  it("org A cannot see org B's users", async () => {
    const orgA = await createTestOrg("tenantA2");
    const orgB = await createTestOrg("tenantB2");
    await createUser(await ownerSession(orgB), {
      email: testEmail("b-only-user"),
      fullName: "B Only User",
      role: "VIEWER",
      password: TEST_PASSWORD,
    });

    const usersVisibleToA = await listUsers(await ownerSession(orgA));
    expect(usersVisibleToA.every((u) => u.id !== orgB.ownerUserId)).toBe(true);
  });

  it("the same email string in two different orgs are independent accounts — logging into org B with org A's credentials fails", async () => {
    // app_user.email is unique per (org_id, email), not globally — the same
    // local-part@domain can legitimately exist in two unrelated orgs. This
    // test exists specifically to prove that fact never becomes a
    // cross-tenant login bypass.
    const sharedEmail = testEmail("shared-login");
    const orgA = await createTestOrg("sharedA");
    const orgB = await createTestOrg("sharedB");

    await createUser(await ownerSession(orgA), {
      email: sharedEmail,
      fullName: "Shared Email User",
      role: "VIEWER",
      password: TEST_PASSWORD,
    });
    // Deliberately NOT creating this email in org B — it must not exist
    // there for this test to mean anything.

    await expect(
      login({ organizationId: orgB.organizationId, email: sharedEmail, password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("org A cannot read org B's audit log", async () => {
    const orgA = await createTestOrg("auditA");
    const orgB = await createTestOrg("auditB");

    const entriesForA = await listAuditLog(await ownerSession(orgA), { limit: 200 });
    expect(entriesForA.every((e) => e.orgId === orgA.organizationId)).toBe(true);
    expect(entriesForA.some((e) => e.entityId === orgB.ownerUserId)).toBe(false);
  });

  it("creating a user with a branchId borrowed from a different org is rejected at the service layer", async () => {
    const orgA = await createTestOrg("crossBranchA");
    const orgB = await createTestOrg("crossBranchB");

    await expect(
      createUser(await ownerSession(orgA), {
        email: testEmail("cross-branch"),
        fullName: "Cross Branch",
        role: "VIEWER",
        password: TEST_PASSWORD,
        branchIds: [orgB.branchId],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
