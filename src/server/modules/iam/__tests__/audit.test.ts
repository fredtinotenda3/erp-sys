import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "./test-helpers";
import { createBranch } from "../branch-service";
import { createUser, deactivateUser } from "../user-service";
import { listAuditLog } from "../audit-service";
import { login, logout } from "../session-service";
import { ForbiddenError } from "../../../shared/errors";
import { createCustomer } from "../../customers/customer-service";

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

// ---- Phase: audit-log viewer filters and branch scope ----

describe("audit log viewer: filters, pagination and branch scope", () => {
  it("filters by actor, action and date range, and pages with a keyset cursor", async () => {
    const org = await createTestOrg("audit-filters");
    const owner = await ownerSession(org);
    const c1 = await createCustomer(owner, { name: "Audit Filter One" });
    await createCustomer(owner, { name: "Audit Filter Two" });

    const mine = await listAuditLog(owner, { actorUserId: owner.userId, action: "create", limit: 200 });
    expect(mine.length).toBeGreaterThan(2);
    expect(mine.every((e) => e.actorUserId === owner.userId && e.action === "create")).toBe(true);
    expect(await listAuditLog(owner, { actorUserId: "00000000-0000-4000-8000-000000000000" })).toHaveLength(0);

    const past = await listAuditLog(owner, { to: new Date("2000-01-01"), limit: 200 });
    expect(past).toHaveLength(0);
    const recent = await listAuditLog(owner, { from: new Date(Date.now() - 3_600_000), limit: 200 });
    expect(recent.length).toBeGreaterThan(0);
    await expect(listAuditLog(owner, { from: new Date("2030-01-02"), to: new Date("2030-01-01") })).rejects.toThrow(/start date is after/);

    const page1 = await listAuditLog(owner, { limit: 2 });
    const page2 = await listAuditLog(owner, { limit: 2, beforeId: page1[1].id });
    expect(page1).toHaveLength(2);
    expect(page2.every((e) => e.id < page1[1].id)).toBe(true);
    expect(new Set([...page1, ...page2].map((e) => e.id)).size).toBe(page1.length + page2.length);

    const byId = await listAuditLog(owner, { entityType: "customer", entityId: c1.id });
    expect(byId).toHaveLength(1);
    await expect(listAuditLog(owner, { entityId: "not-a-uuid" })).rejects.toThrow(/valid id/);
    await expect(listAuditLog(owner, { action: "explode" as never })).rejects.toThrow(/Unknown audit action/);
  });

  it("limits a non-owner reader to org-wide entries plus their own branches", async () => {
    const org = await createTestOrg("audit-scope");
    const owner = await ownerSession(org);
    const other = await createBranch(owner, { name: `Hidden ${Date.now()}` });
    const email = testEmail("fin");
    await createUser(owner, { email, fullName: "Finance", role: "FINANCE_MANAGER", password: TEST_PASSWORD, branchIds: [org.branchId] });
    const { session: finance } = await loginAs(org.organizationId, email);

    const visible = await listAuditLog(finance, { limit: 200 });
    expect(visible.some((e) => e.branchId === other.id)).toBe(false); // the other branch's history is hidden
    expect(visible.some((e) => e.branchId === null)).toBe(true); // org-wide entries remain
    await expect(listAuditLog(finance, { branchId: other.id })).rejects.toThrow(/access to this branch/);
    // The owner still sees everything.
    expect((await listAuditLog(owner, { limit: 200 })).some((e) => e.branchId === other.id)).toBe(true);
  });
});
