// Custom Postgres-backed session auth (not NextAuth — see ARCHITECTURE.md
// for the rationale: instant server-side revocability and a session payload
// shaped around this domain's org/branch/role model). A session is an
// opaque random token; only its SHA-256 hash is ever stored, so a database
// read (or leak) of user_session never discloses a usable token.
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { prisma, type Db } from "../../shared/db";
import { UnauthorizedError, ValidationError } from "../../shared/errors";
import { verifyPassword } from "../../shared/password";
import type { Role } from "../../shared/authz";
import { recordAudit } from "./audit-service";

// Fixed-duration, revocable session. 24h balances "don't make shop-floor
// users re-login constantly" against "a stolen token doesn't live forever";
// revocation (logout, or deactivating a user — see user-service.ts) is the
// actual security control for the "something went wrong, cut this off now"
// case, not a short TTL. Not a spec answer — flag if you want this shorter
// (e.g. 8h to match a single shift) or sliding instead of fixed.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const loginSchema = z.object({
  // Login is scoped to one organization per request because app_user.email
  // is only unique PER ORGANIZATION (org_id, email), not platform-wide — the
  // same email can legitimately exist in two unrelated orgs. This means the
  // client must know/select which organization it's logging into before
  // calling this (e.g. a per-org login link, or an org picker screen) — a
  // genuine product decision for the actual login UI, not assumed away here.
  // Flag if you'd rather make email globally unique and drop this field.
  organizationId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
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

export async function login(input: unknown, context: LoginContext = {}): Promise<LoginResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid login payload", parsed.error.issues);
  const { organizationId, email, password } = parsed.data;

  const user = await prisma.user.findFirst({ where: { orgId: organizationId, email } });

  // Identical error for "no such user" and "correct user, wrong password" —
  // deliberately not distinguishing them in the response, to avoid account
  // enumeration. isActive is checked here too so a deactivated user's
  // correct password still yields the same generic failure rather than a
  // distinct "account disabled" message that would itself leak account
  // existence/state.
  if (!user || !user.isActive) throw new UnauthorizedError("Invalid email or password");

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) throw new UnauthorizedError("Invalid email or password");

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
