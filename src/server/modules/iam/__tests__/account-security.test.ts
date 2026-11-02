// Account security: password change, password reset, login/reset throttling, and session lifecycle.
// Real database, fresh random organizations per test (see test-helpers.ts for why there is no cleanup).
import { describe, expect, it, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../../shared/db";
import { RateLimitError, UnauthorizedError, ValidationError } from "../../../shared/errors";
import { createTestOrg, loginAs, ownerSession, testEmail, TEST_PASSWORD, type TestOrg } from "./test-helpers";
import { createUser, deactivateUser, updateUserRole } from "../user-service";
import { login, validateSessionToken } from "../session-service";
import { changePassword, confirmPasswordReset, requestPasswordReset, setPasswordResetMailer, type ResetMessage } from "../password-service";
import { listCustomers } from "../../customers/customer-service";
import { createCustomer } from "../../customers/customer-service";

const NEW_PASSWORD = "Another-Str0ng-Passw0rd!";
const uniqueIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}-${randomUUID().slice(0, 8)}`;

async function slugOf(org: TestOrg) {
  return (await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId }, select: { slug: true } })).slug;
}
async function userWith(org: TestOrg, role: "VIEWER" | "OPERATIONS_MANAGER" = "VIEWER", branchIds: string[] = [org.branchId]) {
  const owner = await ownerSession(org);
  const email = testEmail("u");
  const user = await createUser(owner, { email, fullName: "Test User", role, password: TEST_PASSWORD, branchIds });
  return { owner, email, user };
}
function captureMail() {
  const sent: ResetMessage[] = [];
  setPasswordResetMailer(async (m) => void sent.push(m));
  return sent;
}
afterEach(() => setPasswordResetMailer(null));

describe("password change", () => {
  it("needs the current password, enforces policy, and ends the user's other sessions but not this one", async () => {
    const org = await createTestOrg("pw-change");
    const { email, user } = await userWith(org);
    const a = await loginAs(org.organizationId, email);
    const b = await loginAs(org.organizationId, email);

    await expect(changePassword(a.session, { currentPassword: "wrong-password-123", newPassword: NEW_PASSWORD })).rejects.toThrow(/Current password is incorrect/);
    await expect(changePassword(a.session, { currentPassword: TEST_PASSWORD, newPassword: "short" })).rejects.toBeInstanceOf(ValidationError);
    await expect(changePassword(a.session, { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })).rejects.toThrow(/different/);

    const res = await changePassword(a.session, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.otherSessionsRevoked).toBe(1);
    expect(await validateSessionToken(a.token)).not.toBeNull(); // the session that made the change stays
    expect(await validateSessionToken(b.token)).toBeNull(); // every other one is gone

    await expect(login({ organizationId: org.organizationId, email, password: TEST_PASSWORD })).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await login({ organizationId: org.organizationId, email, password: NEW_PASSWORD })).session.userId).toBe(user.id);
  });

  it("stores only an argon2 hash and audits the change without any secret in the entry", async () => {
    const org = await createTestOrg("pw-hash");
    const { email, user } = await userWith(org);
    const { session } = await loginAs(org.organizationId, email);
    await changePassword(session, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(row.passwordHash).not.toContain(NEW_PASSWORD);
    const audit = await prisma.auditLog.findMany({ where: { orgId: org.organizationId, entityId: user.id, reason: "password_changed" } });
    expect(audit).toHaveLength(1);
    const dump = JSON.stringify(audit, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(dump).not.toContain(NEW_PASSWORD);
    expect(dump).not.toContain(row.passwordHash);
  });

  it("locks out repeated wrong current-password guesses", async () => {
    const org = await createTestOrg("pw-brute");
    const { email } = await userWith(org);
    const { session } = await loginAs(org.organizationId, email);
    for (let i = 0; i < 5; i++) await expect(changePassword(session, { currentPassword: `wrong-guess-${i}-xyz`, newPassword: NEW_PASSWORD })).rejects.toThrow(/incorrect/);
    // Even the RIGHT password is refused while throttled.
    await expect(changePassword(session, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("password reset", () => {
  it("answers identically for real and unknown accounts, and mints a token only for a real one", async () => {
    const org = await createTestOrg("reset-enum");
    const slug = await slugOf(org);
    const sent = captureMail();
    const ip = uniqueIp();
    await expect(requestPasswordReset({ organizationSlug: slug, email: org.ownerEmail }, { ipAddress: ip })).resolves.toBeUndefined();
    await expect(requestPasswordReset({ organizationSlug: slug, email: "nobody@test.mops.invalid" }, { ipAddress: ip })).resolves.toBeUndefined();
    await expect(requestPasswordReset({ organizationSlug: "no-such-org-xyz", email: org.ownerEmail }, { ipAddress: ip })).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.email).toBe(org.ownerEmail);
  });

  it("stores only a hash, completes once, signs every session out, and the old password stops working", async () => {
    const org = await createTestOrg("reset-flow");
    const slug = await slugOf(org);
    const { email, user } = await userWith(org);
    const sent = captureMail();
    const live = await loginAs(org.organizationId, email);

    await requestPasswordReset({ organizationSlug: slug, email }, { ipAddress: uniqueIp() });
    const token = sent[0]!.token;
    const stored = await prisma.$queryRaw<{ token_hash: string; used_at: Date | null }[]>`SELECT token_hash, used_at FROM password_reset_token WHERE user_id = ${user.id}::uuid`;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);

    await expect(confirmPasswordReset({ token, newPassword: "short" })).rejects.toBeInstanceOf(ValidationError);
    await confirmPasswordReset({ token, newPassword: NEW_PASSWORD }, { ipAddress: uniqueIp() });
    expect(await validateSessionToken(live.token)).toBeNull();
    await expect(login({ organizationId: org.organizationId, email, password: TEST_PASSWORD })).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await login({ organizationId: org.organizationId, email, password: NEW_PASSWORD })).session.userId).toBe(user.id);

    // Single use.
    await expect(confirmPasswordReset({ token, newPassword: "Yet-Another-Passw0rd!" }, { ipAddress: uniqueIp() })).rejects.toThrow(/invalid or has expired/);
  });

  it("rejects expired, forged and superseded tokens with the same message", async () => {
    const org = await createTestOrg("reset-bad");
    const slug = await slugOf(org);
    const { email, user } = await userWith(org);
    const sent = captureMail();
    const ip = uniqueIp();

    await requestPasswordReset({ organizationSlug: slug, email }, { ipAddress: ip });
    const old = sent[0]!.token;
    await requestPasswordReset({ organizationSlug: slug, email }, { ipAddress: ip });
    const fresh = sent[1]!.token;
    await expect(confirmPasswordReset({ token: old, newPassword: NEW_PASSWORD }, { ipAddress: uniqueIp() })).rejects.toThrow(/invalid or has expired/); // superseded
    await expect(confirmPasswordReset({ token: "x".repeat(43), newPassword: NEW_PASSWORD }, { ipAddress: uniqueIp() })).rejects.toThrow(/invalid or has expired/); // forged

    await prisma.$executeRaw`UPDATE password_reset_token SET expires_at = created_at + interval '1 second' WHERE user_id = ${user.id}::uuid`;
    await prisma.$executeRaw`UPDATE password_reset_token SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour' WHERE user_id = ${user.id}::uuid`;
    await expect(confirmPasswordReset({ token: fresh, newPassword: NEW_PASSWORD }, { ipAddress: uniqueIp() })).rejects.toThrow(/invalid or has expired/); // expired
  });

  it("refuses a reset for an account that was deactivated after requesting", async () => {
    const org = await createTestOrg("reset-deact");
    const slug = await slugOf(org);
    const { owner, email, user } = await userWith(org);
    const sent = captureMail();
    await requestPasswordReset({ organizationSlug: slug, email }, { ipAddress: uniqueIp() });
    await deactivateUser(owner, user.id);
    await expect(confirmPasswordReset({ token: sent[0]!.token, newPassword: NEW_PASSWORD }, { ipAddress: uniqueIp() })).rejects.toThrow(/invalid or has expired/);
    // ...and a deactivated user cannot even obtain a new token.
    await requestPasswordReset({ organizationSlug: slug, email }, { ipAddress: uniqueIp() });
    expect(sent).toHaveLength(1);
  });

  it("creates no token when no mail transport is configured (nothing to deliver, nothing to leak)", async () => {
    const org = await createTestOrg("reset-nomail");
    const slug = await slugOf(org);
    setPasswordResetMailer(null);
    await requestPasswordReset({ organizationSlug: slug, email: org.ownerEmail }, { ipAddress: uniqueIp() });
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM password_reset_token WHERE org_id = ${org.organizationId}::uuid`;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("rate limits requests per address and per typed account, identically for real and unknown emails", async () => {
    const org = await createTestOrg("reset-rate");
    const slug = await slugOf(org);
    captureMail();
    // Per typed account: 3 per hour, whether or not it exists.
    for (const email of [org.ownerEmail, `ghost.${randomUUID()}@test.mops.invalid`]) {
      for (let i = 0; i < 3; i++) await requestPasswordReset({ organizationSlug: slug, email }, { ipAddress: uniqueIp() });
      await expect(requestPasswordReset({ organizationSlug: slug, email }, { ipAddress: uniqueIp() })).rejects.toBeInstanceOf(RateLimitError);
    }
    // Per address: 10 per hour across different accounts.
    const ip = uniqueIp();
    for (let i = 0; i < 10; i++) await requestPasswordReset({ organizationSlug: slug, email: `a${i}.${randomUUID()}@test.mops.invalid` }, { ipAddress: ip });
    await expect(requestPasswordReset({ organizationSlug: slug, email: `z.${randomUUID()}@test.mops.invalid` }, { ipAddress: ip })).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("login throttling", () => {
  it("blocks an account after repeated failures from one address, even for the correct password, without affecting others", async () => {
    const org = await createTestOrg("login-rate");
    const { email } = await userWith(org);
    const other = await userWith(org);
    const ip = uniqueIp();
    for (let i = 0; i < 5; i++) await expect(login({ organizationId: org.organizationId, email, password: `wrong-password-${i}` }, { ipAddress: ip })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(login({ organizationId: org.organizationId, email, password: TEST_PASSWORD }, { ipAddress: ip })).rejects.toBeInstanceOf(RateLimitError);
    // Another person's account from the same address is unaffected (below the per-address cap).
    expect((await login({ organizationId: org.organizationId, email: other.email, password: TEST_PASSWORD }, { ipAddress: ip })).session.userId).toBe(other.user.id);
    // The same account from a different address is not locked by the first address's failures.
    expect((await login({ organizationId: org.organizationId, email, password: TEST_PASSWORD }, { ipAddress: uniqueIp() })).session.userId).toBeTruthy();
  });

  it("throttles guesses against accounts that do not exist exactly like real ones", async () => {
    const ip = uniqueIp();
    const ghost = { organizationSlug: "no-such-org-xyz", email: "ghost@test.mops.invalid", password: "whatever-password" };
    for (let i = 0; i < 5; i++) await expect(login(ghost, { ipAddress: ip })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(login(ghost, { ipAddress: ip })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("caps password spraying from one address across many accounts", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < 30; i++) await expect(login({ organizationSlug: "no-such-org-xyz", email: `s${i}@test.mops.invalid`, password: "spray-password-1" }, { ipAddress: ip })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(login({ organizationSlug: "no-such-org-xyz", email: "s99@test.mops.invalid", password: "spray-password-1" }, { ipAddress: ip })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("a correct login clears that person's own failure streak", async () => {
    const org = await createTestOrg("login-clear");
    const { email } = await userWith(org);
    const ip = uniqueIp();
    for (let i = 0; i < 4; i++) await expect(login({ organizationId: org.organizationId, email, password: `bad-password-${i}` }, { ipAddress: ip })).rejects.toBeInstanceOf(UnauthorizedError);
    await login({ organizationId: org.organizationId, email, password: TEST_PASSWORD }, { ipAddress: ip });
    for (let i = 0; i < 4; i++) await expect(login({ organizationId: org.organizationId, email, password: `bad-again-${i}` }, { ipAddress: ip })).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("session lifecycle and permission changes", () => {
  it("a deactivated user's existing session stops working immediately", async () => {
    const org = await createTestOrg("sess-deact");
    const { owner, email, user } = await userWith(org);
    const { token } = await loginAs(org.organizationId, email);
    expect(await validateSessionToken(token)).not.toBeNull();
    await deactivateUser(owner, user.id);
    expect(await validateSessionToken(token)).toBeNull();
    await expect(login({ organizationId: org.organizationId, email, password: TEST_PASSWORD })).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("a role change applies to the live session on its very next request", async () => {
    const org = await createTestOrg("sess-role");
    const { owner, email, user } = await userWith(org, "VIEWER");
    const { token } = await loginAs(org.organizationId, email);
    await expect(createCustomer((await validateSessionToken(token))!, { name: "Nope" })).rejects.toThrow(/does not have/);
    await updateUserRole(owner, user.id, "OPERATIONS_MANAGER");
    const upgraded = (await validateSessionToken(token))!;
    expect(upgraded.role).toBe("OPERATIONS_MANAGER");
    expect((await createCustomer(upgraded, { name: "Now allowed" })).name).toBe("Now allowed");
    await updateUserRole(owner, user.id, "VIEWER");
    await expect(createCustomer((await validateSessionToken(token))!, { name: "Revoked again" })).rejects.toThrow(/does not have/);
    expect((await listCustomers((await validateSessionToken(token))!)).length).toBeGreaterThan(0);
  });
});
