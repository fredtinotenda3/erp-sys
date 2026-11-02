// Password change and password reset, built on the existing session/argon2 machinery (no second
// auth system).
//
// Design rules (each one is covered by a test in __tests__/account-security.test.ts):
//  - A reset token is 256 random bits, emailed once, stored only as its SHA-256, valid 30 minutes,
//    single use. Requesting a new one retires older unused ones.
//  - requestPasswordReset ALWAYS answers the same way and is rate limited by what was TYPED, not by
//    whether the account exists, so neither the response nor the 429 reveals which emails have accounts.
//  - Changing or resetting a password ends the user's other sessions (all of them, for a reset).
//  - Tokens and passwords are never logged, audited, or returned by any API in production.
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../../shared/db";
import { RateLimitError, UnauthorizedError, ValidationError } from "../../shared/errors";
import { hashPassword, verifyPassword } from "../../shared/password";
import { recordAudit } from "./audit-service";
import { assertNotThrottled, throttleClear, throttleHit, throttleKey, type Limit } from "./auth-throttle";
import type { AuthenticatedSession } from "./session-service";

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

export const RESET_REQUEST_IP_LIMIT: Limit = { limit: 10, windowMs: 60 * 60 * 1000 };
export const RESET_REQUEST_ACCOUNT_LIMIT: Limit = { limit: 3, windowMs: 60 * 60 * 1000 };
export const RESET_CONFIRM_IP_LIMIT: Limit = { limit: 20, windowMs: 60 * 60 * 1000 };
export const CHANGE_PASSWORD_FAILURE_LIMIT: Limit = { limit: 5, windowMs: 15 * 60 * 1000 };

// Same bounds user-service uses when it creates an account.
const newPasswordSchema = z.string().min(12, "Use at least 12 characters").max(200, "Use at most 200 characters");

export interface RequestContext {
  ipAddress?: string;
}

// ---- delivery -------------------------------------------------------------------------------

export interface ResetMessage {
  email: string;
  organizationSlug: string;
  token: string;
  expiresAt: Date;
}
export type PasswordResetMailer = (message: ResetMessage) => Promise<void>;

let mailer: PasswordResetMailer | null = null;

/** Production wiring point: register a function that emails the link. Nothing else sends mail. */
export function setPasswordResetMailer(m: PasswordResetMailer | null): void {
  mailer = m;
}

// Development-only fallback: with NODE_ENV=development AND PASSWORD_RESET_DEV_OUTBOX=1, the reset link
// is appended to .dev-outbox/password-reset.log on the developer's machine. It is impossible to turn on
// in production, and the token never appears in a response or in console output.
async function devOutboxMailer(m: ResetMessage): Promise<void> {
  await mkdir(".dev-outbox", { recursive: true });
  const base = process.env.APP_BASE_URL ?? "http://localhost:3000";
  const url = `${base}/reset-password?token=${encodeURIComponent(m.token)}`;
  await appendFile(".dev-outbox/password-reset.log", `${new Date().toISOString()} ${m.email} (${m.organizationSlug}) ${url}\n`);
}

function activeMailer(): PasswordResetMailer | null {
  if (mailer) return mailer;
  if (process.env.NODE_ENV === "development" && process.env.PASSWORD_RESET_DEV_OUTBOX === "1") return devOutboxMailer;
  return null;
}

// ---- helpers --------------------------------------------------------------------------------

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const iso = (d: Date) => d.toISOString();

async function enforce(scope: string, identifier: string, rule: Limit): Promise<void> {
  const { count } = await throttleHit(throttleKey(scope, identifier), rule);
  if (count > rule.limit) throw new RateLimitError("Too many attempts. Please try again later.", Math.ceil(rule.windowMs / 1000));
}

// ---- reset request --------------------------------------------------------------------------

const requestSchema = z.object({
  organizationSlug: z.string().trim().toLowerCase().min(1).max(50),
  email: z.string().trim().toLowerCase().email().max(254),
});

/** Always resolves the same way whether or not the account exists. Only format errors and rate limits throw. */
export async function requestPasswordReset(input: unknown, context: RequestContext = {}): Promise<void> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Enter your organization and a valid email address");
  const { organizationSlug, email } = parsed.data;

  // Counted BEFORE any lookup, keyed on what was typed.
  await enforce("reset-req-ip", context.ipAddress ?? "unknown", RESET_REQUEST_IP_LIMIT);
  await enforce("reset-req-acct", `${organizationSlug}:${email}`, RESET_REQUEST_ACCOUNT_LIMIT);

  const org = await prisma.organization.findUnique({ where: { slug: organizationSlug }, select: { id: true } });
  if (!org) return;
  const user = await prisma.user.findFirst({ where: { orgId: org.id, email } });
  if (!user || !user.isActive) return;

  const send = activeMailer();
  if (!send) {
    // No way to deliver, so do not mint a token nobody can use. No email, token or user id in the log.
    console.warn("Password reset requested but no mail transport is configured; no token was created.");
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE password_reset_token SET used_at = ${iso(now)}::timestamptz AT TIME ZONE 'UTC'
                          WHERE user_id = ${user.id}::uuid AND used_at IS NULL`;
    await tx.$executeRaw`INSERT INTO password_reset_token (org_id, user_id, token_hash, created_at, expires_at, requested_ip)
                         VALUES (${org.id}::uuid, ${user.id}::uuid, ${hashToken(token)},
                                 ${iso(now)}::timestamptz AT TIME ZONE 'UTC', ${iso(expiresAt)}::timestamptz AT TIME ZONE 'UTC', ${context.ipAddress ?? null})`;
    await recordAudit(tx, { orgId: org.id, actorUserId: null, entityType: "app_user", entityId: user.id, action: "update", reason: "password_reset_requested" });
  });

  try {
    await send({ email, organizationSlug, token, expiresAt });
  } catch {
    console.error("Password reset delivery failed."); // deliberately no detail: it could contain the address or link
  }
}

// ---- reset confirm --------------------------------------------------------------------------

const confirmSchema = z.object({ token: z.string().min(20).max(200), newPassword: newPasswordSchema });
const INVALID_LINK = "This reset link is invalid or has expired. Request a new one.";

export async function confirmPasswordReset(input: unknown, context: RequestContext = {}): Promise<void> {
  await enforce("reset-confirm-ip", context.ipAddress ?? "unknown", RESET_CONFIRM_IP_LIMIT);
  const parsed = confirmSchema.safeParse(input);
  if (!parsed.success) {
    const tokenBad = parsed.error.issues.some((i) => i.path[0] === "token");
    if (tokenBad) throw new ValidationError(INVALID_LINK);
    throw new ValidationError("Choose a stronger password", parsed.error.issues);
  }
  const newHash = await hashPassword(parsed.data.newPassword); // heavy work outside the transaction

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    // Claim the token atomically: of two simultaneous uses, exactly one gets a row back.
    const claimed = await tx.$queryRaw<{ org_id: string; user_id: string }[]>`
      UPDATE password_reset_token SET used_at = ${iso(now)}::timestamptz AT TIME ZONE 'UTC'
       WHERE token_hash = ${hashToken(parsed.data.token)} AND used_at IS NULL
         AND expires_at > ${iso(now)}::timestamptz AT TIME ZONE 'UTC'
       RETURNING org_id, user_id`;
    const row = claimed[0];
    if (!row) throw new ValidationError(INVALID_LINK);

    const user = await tx.user.findFirst({ where: { orgId: row.org_id, id: row.user_id } });
    if (!user || !user.isActive) throw new ValidationError(INVALID_LINK);

    await tx.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    await tx.userSession.updateMany({ where: { orgId: user.orgId, userId: user.id, revokedAt: null }, data: { revokedAt: now } });
    await tx.$executeRaw`UPDATE password_reset_token SET used_at = ${iso(now)}::timestamptz AT TIME ZONE 'UTC'
                          WHERE user_id = ${user.id}::uuid AND used_at IS NULL`;
    await recordAudit(tx, { orgId: user.orgId, actorUserId: user.id, entityType: "app_user", entityId: user.id, action: "update", reason: "password_reset_completed" });
  });
}

// ---- change (signed in) ---------------------------------------------------------------------

const changeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: newPasswordSchema });

export async function changePassword(session: AuthenticatedSession, input: unknown): Promise<{ otherSessionsRevoked: number }> {
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid password change", parsed.error.issues);
  const { currentPassword, newPassword } = parsed.data;

  const failKey = throttleKey("change-pw", session.userId);
  await assertNotThrottled([{ key: failKey, rule: CHANGE_PASSWORD_FAILURE_LIMIT }]);

  const user = await prisma.user.findFirst({ where: { orgId: session.orgId, id: session.userId } });
  if (!user || !user.isActive) throw new UnauthorizedError("Session is invalid, expired, or revoked");

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    await throttleHit(failKey, CHANGE_PASSWORD_FAILURE_LIMIT);
    throw new ValidationError("Current password is incorrect", [{ path: ["currentPassword"], message: "Current password is incorrect" }]);
  }
  if (currentPassword === newPassword) {
    throw new ValidationError("Choose a password different from the current one", [{ path: ["newPassword"], message: "Choose a password different from the current one" }]);
  }
  await throttleClear(failKey);

  const newHash = await hashPassword(newPassword);
  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
    // Everyone else signed in as this user is signed out; the session making the change stays.
    const revoked = await tx.userSession.updateMany({
      where: { orgId: user.orgId, userId: user.id, revokedAt: null, id: { not: session.sessionId } },
      data: { revokedAt: new Date() },
    });
    await recordAudit(tx, { orgId: user.orgId, actorUserId: user.id, entityType: "app_user", entityId: user.id, action: "update", reason: "password_changed" });
    return { otherSessionsRevoked: revoked.count };
  });
}
