import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "./test-helpers";
import { login, logout, validateSessionToken } from "../session-service";
import { createUser, deactivateUser, updateUserRole } from "../user-service";
import { ConflictError, ForbiddenError, UnauthorizedError } from "../../../shared/errors";

describe("authentication and session lifecycle", () => {
  it("rejects a wrong password", async () => {
    const org = await createTestOrg("wrongPw");
    await expect(
      login({ organizationId: org.organizationId, email: org.ownerEmail, password: "definitely-wrong" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a nonexistent email with the SAME error as a wrong password (no account-existence leak)", async () => {
    const org = await createTestOrg("noSuchUser");
    await expect(
      login({ organizationId: org.organizationId, email: testEmail("nobody"), password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("issues a usable token on login, and validateSessionToken resolves it to the right user/org", async () => {
    const org = await createTestOrg("issue");
    const { token, session } = await login({
      organizationId: org.organizationId,
      email: org.ownerEmail,
      password: TEST_PASSWORD,
    });

    const resolved = await validateSessionToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.userId).toBe(session.userId);
    expect(resolved?.orgId).toBe(org.organizationId);
    expect(resolved?.role).toBe("OWNER_ADMIN");
  });

  it("logout revokes the token immediately — it stops validating in the same process", async () => {
    const org = await createTestOrg("revokeSelf");
    const { token } = await login({ organizationId: org.organizationId, email: org.ownerEmail, password: TEST_PASSWORD });

    expect(await validateSessionToken(token)).not.toBeNull();
    await logout(token);
    expect(await validateSessionToken(token)).toBeNull();
  });

  it("deactivating a user immediately revokes their existing session (instant revocability)", async () => {
    const org = await createTestOrg("deactivateRevoke");
    const owner = await ownerSession(org);
    const email = testEmail("to-deactivate");
    const user = await createUser(owner, { email, fullName: "To Deactivate", role: "VIEWER", password: TEST_PASSWORD });

    const { token } = await loginAs(org.organizationId, email);
    expect(await validateSessionToken(token)).not.toBeNull();

    await deactivateUser(owner, user.id);
    expect(await validateSessionToken(token)).toBeNull();
  });

  it("a deactivated user cannot log back in", async () => {
    const org = await createTestOrg("deactivatedLogin");
    const owner = await ownerSession(org);
    const email = testEmail("will-be-deactivated");
    const user = await createUser(owner, { email, fullName: "Will Be Deactivated", role: "VIEWER", password: TEST_PASSWORD });
    await deactivateUser(owner, user.id);

    await expect(
      login({ organizationId: org.organizationId, email, password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("a garbage/forged token never resolves to a session", async () => {
    expect(await validateSessionToken("this-was-never-issued-by-the-server")).toBeNull();
  });

  it("refuses to demote the last active OWNER_ADMIN", async () => {
    const org = await createTestOrg("lastOwner");
    const owner = await ownerSession(org);
    await expect(updateUserRole(owner, org.ownerUserId, "OPERATIONS_MANAGER")).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to deactivate the last active OWNER_ADMIN", async () => {
    const org = await createTestOrg("lastOwnerDeactivate");
    const owner = await ownerSession(org);
    await expect(deactivateUser(owner, org.ownerUserId)).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows demoting an OWNER_ADMIN once a second OWNER_ADMIN exists", async () => {
    const org = await createTestOrg("secondOwner");
    const owner = await ownerSession(org);
    const email = testEmail("second-owner");
    const secondOwner = await createUser(owner, {
      email,
      fullName: "Second Owner",
      role: "OWNER_ADMIN",
      password: TEST_PASSWORD,
    });

    const demoted = await updateUserRole(owner, secondOwner.id, "VIEWER");
    expect(demoted.role).toBe("VIEWER");
  });

  it("an OPERATIONS_MANAGER cannot create another OWNER_ADMIN (privilege-escalation guard)", async () => {
    const org = await createTestOrg("escalation");
    const owner = await ownerSession(org);
    const opsEmail = testEmail("ops-manager");
    await createUser(owner, { email: opsEmail, fullName: "Ops Manager", role: "OPERATIONS_MANAGER", password: TEST_PASSWORD });

    const { session: opsSession } = await loginAs(org.organizationId, opsEmail);
    await expect(
      createUser(opsSession, {
        email: testEmail("new-owner"),
        fullName: "New Owner",
        role: "OWNER_ADMIN",
        password: TEST_PASSWORD,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an OPERATIONS_MANAGER cannot change anyone's role (user:update_role is OWNER_ADMIN-only)", async () => {
    const org = await createTestOrg("rolesLocked");
    const owner = await ownerSession(org);
    const opsEmail = testEmail("ops-manager2");
    const opsUser = await createUser(owner, {
      email: opsEmail,
      fullName: "Ops Manager 2",
      role: "OPERATIONS_MANAGER",
      password: TEST_PASSWORD,
    });

    const { session: opsSession } = await loginAs(org.organizationId, opsEmail);
    await expect(updateUserRole(opsSession, opsUser.id, "VIEWER")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a VIEWER cannot create users (capability check)", async () => {
    const org = await createTestOrg("viewerNoCreate");
    const owner = await ownerSession(org);
    const email = testEmail("viewer-no-create");
    await createUser(owner, { email, fullName: "Viewer", role: "VIEWER", password: TEST_PASSWORD });

    const { session } = await loginAs(org.organizationId, email);
    await expect(
      createUser(session, { email: testEmail("blocked"), fullName: "Blocked", role: "VIEWER", password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
