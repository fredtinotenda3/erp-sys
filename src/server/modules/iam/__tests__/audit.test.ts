import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "./test-helpers";
import { createBranch } from "../branch-service";
import { createUser, deactivateUser } from "../user-service";
import { listAuditLog } from "../audit-service";
import { login, logout } from "../session-service";
import { ForbiddenError } from "../../../shared/errors";

describe("audit log correctness", () => {
  it("records organization, branch, and owner-user creation on bootstrap", async () => {
    const org = await createTestOrg("auditBootstrap");
    const owner = await ownerSession(org);
    const entries = await listAuditLog(owner, { limit: 200 });

    expect(
      entries.some((e) => e.entityType === "organization" && e.entityId === org.organizationId && e.action === "create"),
    ).toBe(true);
    expect(
      entries.some((e) => e.entityType === "branch" && e.entityId === org.branchId && e.action === "create"),
    ).toBe(true);
    expect(
      entries.some((e) => e.entityType === "app_user" && e.entityId === org.ownerUserId && e.action === "create"),
    ).toBe(true);
  });

  it("records a login as a user_session create event attributed to the correct actor", async () => {
    const org = await createTestOrg("auditLogin");
    const owner = await ownerSession(org);
    const { session } = await login({ organizationId: org.organizationId, email: org.ownerEmail, password: TEST_PASSWORD });

    const entries = await listAuditLog(owner, { entityType: "user_session", entityId: session.sessionId, limit: 10 });
    expect(entries.some((e) => e.action === "create" && e.actorUserId === org.ownerUserId)).toBe(true);
  });

  it("records logout as a revoke event on the same session entity", async () => {
    const org = await createTestOrg("auditLogout");
    const owner = await ownerSession(org);
    const { token, session } = await login({ organizationId: org.organizationId, email: org.ownerEmail, password: TEST_PASSWORD });
    await logout(token);

    const entries = await listAuditLog(owner, { entityType: "user_session", entityId: session.sessionId, limit: 10 });
    expect(entries.some((e) => e.action === "revoke")).toBe(true);
  });

  it("records user deactivation with accurate before/after isActive values", async () => {
    const org = await createTestOrg("auditDeactivate");
    const owner = await ownerSession(org);
    const email = testEmail("to-audit-deactivate");
    const user = await createUser(owner, { email, fullName: "Audit Deactivate", role: "VIEWER", password: TEST_PASSWORD });
    await deactivateUser(owner, user.id);

    const entries = await listAuditLog(owner, { entityType: "app_user", entityId: user.id, limit: 10 });
    const deactivation = entries.find((e) => e.action === "update" && e.reason === "deactivated");

    expect(deactivation).toBeDefined();
    expect(deactivation?.beforeValue).toMatchObject({ isActive: true });
    expect(deactivation?.afterValue).toMatchObject({ isActive: false });
  });

  it("every audit entry returned to org A's owner belongs to org A (belt-and-suspenders on top of the dedicated cross-org test)", async () => {
    const org = await createTestOrg("auditScopeCheck");
    const owner = await ownerSession(org);
    await createBranch(owner, { name: "Audited Branch" });

    const entries = await listAuditLog(owner, { limit: 200 });
    expect(entries.every((e) => e.orgId === org.organizationId)).toBe(true);
  });

  it("a VIEWER cannot read the audit log (capability check)", async () => {
    const org = await createTestOrg("auditCapability");
    const owner = await ownerSession(org);
    const email = testEmail("viewer-no-audit");
    await createUser(owner, { email, fullName: "Viewer No Audit", role: "VIEWER", password: TEST_PASSWORD });

    const { session } = await loginAs(org.organizationId, email);
    await expect(listAuditLog(session)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
