// Custom Postgres-backed session auth (not NextAuth — see ARCHITECTURE.md
// for the rationale: instant server-side revocability and a session payload
// shaped around this domain's org/branch/role model). A session is an
// opaque random token; only its SHA-256 hash is ever stored, so a database
// read (or leak) of user_session never discloses a usable token.
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { prisma, type Db } from "../../shared/db";
import { UnauthorizedError, ValidationError } from "../../shared/errors";
import { hashPassword, verifyPassword } from "../../shared/password";
import type { Role } from "../../shared/authz";
import { recordAudit } from "./audit-service";
import { assertNotThrottled, throttleClear, throttleHit, throttleKey, type Limit } from "./auth-throttle";

// Fixed-duration, revocable session. 24h balances "don't make shop-floor
// users re-login constantly" against "a stolen token doesn't live forever";
// revocation (logout, or deactivating a user — see user-service.ts) is the
// actual security control for the "something went wrong, cut this off now"
// case, not a short TTL. Not a spec answer — flag if you want this shorter
// (e.g. 8h to match a single shift) or sliding instead of fixed.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Login is scoped to one organization per request because app_user.email is
// only unique PER ORGANIZATION (org_id, email). The user identifies their
// organization with its short login handle (organizationSlug, e.g.
// "acme-furniture"). organizationId (UUID) is still accepted for internal
// callers and tests; exactly one of the two must be supplied.
const loginSchema = z
  .object({
    organizationSlug: z.string().trim().toLowerCase().min(1).max(50).optional(),
    organizationId: z.string().uuid().optional(),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
  })
  .refine((v) => Boolean(v.organizationSlug) !== Boolean(v.organizationId), {
    message: "Provide exactly one of organizationSlug or organizationId",
    path: ["organizationSlug"],
  });

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly role: Role;
  // Explicit grants only. Does NOT expand OWNER_ADMIN's implicit all-branch
  // access into every branch ID in the org — callers must check role via
  // shared/authz.ts's hasBranchAccess()/assertBranchAccess(), which encode
  // that rule in exactly one place.
  readonly branchIds: readonly string[];
}

export interface LoginContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  session: AuthenticatedSession;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function loadBranchIds(orgId: string, userId: string): Promise<string[]> {
  const rows = await prisma.userBranchAccess.findMany({
    where: { orgId, userId },
    select: { branchId: true },
  });
  return rows.map((r) => r.branchId);
}

// Failed-login throttling. Three counters, because each alone is either weak or abusable:
//  - per (account + address): the tight one that stops guessing a password from one place;
//  - per address: stops one place spraying many accounts;
//  - per account: a looser cap against a distributed guess, loose enough that an attacker cannot
//    cheaply lock a real user out by typing wrong passwords for them.
// All three count what was TYPED (org + email), whether or not the account exists, so a lockout never
// reveals which accounts are real.
export const LOGIN_ACCOUNT_IP_LIMIT: Limit = { limit: 5, windowMs: 15 * 60 * 1000 };
export const LOGIN_IP_LIMIT: Limit = { limit: 30, windowMs: 15 * 60 * 1000 };
export const LOGIN_ACCOUNT_LIMIT: Limit = { limit: 20, windowMs: 15 * 60 * 1000 };

// A real argon2 hash of a throwaway string, computed once. Verifying against it when the account does
// not exist makes "no such user" cost the same time as "wrong password", so response time does not
// reveal which emails have accounts.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(16).toString("hex")));

export async function login(input: unknown, context: LoginContext = {}): Promise<LoginResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid login payload", parsed.error.issues);
  const { organizationSlug, email, password } = parsed.data;

  // Resolve the organization. An unknown slug produces the SAME generic
  // error as a wrong password so the login form can't be used to discover
  // which organization handles exist.
  const address = context.ipAddress ?? "unknown";
  const accountId = `${organizationSlug ?? parsed.data.organizationId}:${email}`;
  const keyAccountIp = throttleKey("login-acct-ip", `${accountId}|${address}`);
  const keyIp = throttleKey("login-ip", address);
  const keyAccount = throttleKey("login-acct", accountId);
  // With no known address (a host that sets no forwarding header, or an internal caller) the per-address
  // counter is skipped: lumping every such caller into one bucket would let a single attacker lock
  // everybody out. The per-account counters still apply.
  const useIp = address !== "unknown";
  await assertNotThrottled([
    { key: keyAccountIp, rule: LOGIN_ACCOUNT_IP_LIMIT },
    ...(useIp ? [{ key: keyIp, rule: LOGIN_IP_LIMIT }] : []),
    { key: keyAccount, rule: LOGIN_ACCOUNT_LIMIT },
  ]);
  const fail = async (message: string): Promise<never> => {
    await Promise.all([
      throttleHit(keyAccountIp, LOGIN_ACCOUNT_IP_LIMIT),
      ...(useIp ? [throttleHit(keyIp, LOGIN_IP_LIMIT)] : []),
      throttleHit(keyAccount, LOGIN_ACCOUNT_LIMIT),
    ]);
    throw new UnauthorizedError(message);
  };

  let organizationId = parsed.data.organizationId;
  if (organizationSlug) {
    const org = await prisma.organization.findUnique({ where: { slug: organizationSlug }, select: { id: true } });
    if (org) organizationId = org.id;
  }
  const user = organizationId ? await prisma.user.findFirst({ where: { orgId: organizationId, email } }) : null;

  // Identical error for "no such user" and "correct user, wrong password" —
  // deliberately not distinguishing them in the response, to avoid account
  // enumeration. isActive is checked here too so a deactivated user's
  // correct password still yields the same generic failure rather than a
  // distinct "account disabled" message that would itself leak account
  // existence/state.
  if (!user || !user.isActive || !organizationId) {
    await verifyPassword(await getDummyHash(), password); // equalise timing with the real-user path
    return fail("Invalid email or password");
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) return fail("Invalid email or password");
  await throttleClear(keyAccountIp); // a correct password clears this person's own failure streak

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const sessionRow = await prisma.userSession.create({
    data: {
      orgId: organizationId,
      userId: user.id,
      tokenHash,
      expiresAt,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    },
  });

  const branchIds = await loadBranchIds(organizationId, user.id);

  await recordAudit(prisma, {
    orgId: organizationId,
    actorUserId: user.id,
    entityType: "user_session",
    entityId: sessionRow.id,
    action: "create",
    reason: "login",
  });

  return {
    token,
    expiresAt,
    session: {
      sessionId: sessionRow.id,
      orgId: organizationId,
      userId: user.id,
      role: user.role as Role,
      branchIds,
    },
  };
}

export async function validateSessionToken(token: string): Promise<AuthenticatedSession | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);

  const sessionRow = await prisma.userSession.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!sessionRow) return null;
  if (sessionRow.revokedAt) return null;
  if (sessionRow.expiresAt.getTime() <= Date.now()) return null;
  if (!sessionRow.user.isActive) return null;

  const branchIds = await loadBranchIds(sessionRow.orgId, sessionRow.userId);

  return {
    sessionId: sessionRow.id,
    orgId: sessionRow.orgId,
    userId: sessionRow.userId,
    role: sessionRow.user.role as Role,
    branchIds,
  };
}

export async function logout(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);

  const sessionRow = await prisma.userSession.findUnique({ where: { tokenHash } });
  if (!sessionRow || sessionRow.revokedAt) return;

  await prisma.userSession.update({ where: { id: sessionRow.id }, data: { revokedAt: new Date() } });
  await recordAudit(prisma, {
    orgId: sessionRow.orgId,
    actorUserId: sessionRow.userId,
    entityType: "user_session",
    entityId: sessionRow.id,
    action: "revoke",
    reason: "logout",
  });
}

// Used by user-service.ts when deactivating a user — all of that user's
// active sessions are cut immediately rather than being left to expire
// naturally, matching the "instant revocability" design goal.
export async function revokeAllSessionsForUser(db: Db, orgId: string, userId: string): Promise<number> {
  const result = await db.userSession.updateMany({
    where: { orgId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}
