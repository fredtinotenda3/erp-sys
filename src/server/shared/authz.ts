// Role/capability model for Phase 1 (IAM module only — no scope creep into
// capabilities for modules that don't exist yet; later phases add their own
// capability constants here rather than inventing a second authz system).
//
// ROLE VALUES ARE REDECLARED HERE, NOT IMPORTED FROM THE GENERATED PRISMA
// CLIENT. This is deliberate, not an oversight: `npx prisma generate` could
// not be run in the sandbox this was built in (binaries.prisma.sh is
// network-blocked there — see ARCHITECTURE.md Phase 0 Addendum, "Known
// verification gap"), so the exact shape of Prisma 7's generated enum export
// (a real TS `enum`, vs. a `const` object + derived union type, which is
// Prisma's historical pattern) was not independently confirmed. A plain
// string-literal union here is guaranteed to compile against either shape at
// every call site that assigns a role to a Prisma field, whereas importing
// the generated type first and it turning out to be a real `enum` would
// require every literal assignment (`role: 'OWNER_ADMIN'`) to be rewritten
// as `role: Role.OWNER_ADMIN`. After your first successful `prisma generate`,
// it is safe (and preferable, for single-source-of-truth) to replace
// ROLE_VALUES/Role below with `import type { Role } from
// "../../generated/prisma/client"` — just confirm the 7 values below still
// match prisma/schema.prisma's `enum Role` first.
import { ForbiddenError } from "./errors";

export const ROLE_VALUES = [
  "OWNER_ADMIN",
  "OPERATIONS_MANAGER",
  "PRODUCTION_MANAGER",
  "INVENTORY_MANAGER",
  "PRODUCTION_OPERATOR",
  "FINANCE_MANAGER",
  "VIEWER",
] as const;

export type Role = (typeof ROLE_VALUES)[number];

export type Capability =
  | "branch:create"
  | "branch:read"
  | "branch:deactivate"
  | "user:create"
  | "user:read"
  | "user:update_role"
  | "user:deactivate"
  | "branch_access:grant"
  | "branch_access:revoke"
  | "audit_log:read";

// Deliberately NOT granting user:update_role to anyone but OWNER_ADMIN.
// Role changes are the one IAM action with privilege-escalation potential
// (a user who can set roles can promote themselves or anyone else to
// OWNER_ADMIN), so it is kept out of the "ops admin" tier even though that
// tier can otherwise create/deactivate users and manage branches. This is a
// Phase 1 default, not a spec answer — flag if you want a narrower or wider
// rule here.
const CAPABILITIES_BY_ROLE: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  OWNER_ADMIN: new Set<Capability>([
    "branch:create",
    "branch:read",
    "branch:deactivate",
    "user:create",
    "user:read",
    "user:update_role",
    "user:deactivate",
    "branch_access:grant",
    "branch_access:revoke",
    "audit_log:read",
  ]),
  OPERATIONS_MANAGER: new Set<Capability>([
    "branch:create",
    "branch:read",
    "branch:deactivate",
    "user:create",
    "user:read",
    "user:deactivate",
    "branch_access:grant",
    "branch_access:revoke",
    "audit_log:read",
  ]),
  PRODUCTION_MANAGER: new Set<Capability>(["branch:read", "user:read"]),
  INVENTORY_MANAGER: new Set<Capability>(["branch:read", "user:read"]),
  PRODUCTION_OPERATOR: new Set<Capability>(["branch:read"]),
  FINANCE_MANAGER: new Set<Capability>(["branch:read", "user:read", "audit_log:read"]),
  VIEWER: new Set<Capability>(["branch:read"]),
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].has(capability);
}

export function assertCapability(role: Role, capability: Capability): void {
  if (!hasCapability(role, capability)) {
    throw new ForbiddenError(`Role ${role} does not have the "${capability}" capability`);
  }
}

// Branch-level access check. OWNER_ADMIN gets IMPLICIT access to every
// branch in its org (ARCHITECTURE.md Section 15, Q4 — answered: implicit),
// enforced here in code rather than by materializing a user_branch_access
// row per branch for every OWNER_ADMIN (which would need to be kept in sync
// every time a new branch is created). Every other role must hold an
// explicit grant row — there is no fallback to org-wide access for them.
export function hasBranchAccess(session: { role: Role; branchIds: readonly string[] }, branchId: string): boolean {
  if (session.role === "OWNER_ADMIN") return true;
  return session.branchIds.includes(branchId);
}

export function assertBranchAccess(session: { role: Role; branchIds: readonly string[] }, branchId: string): void {
  if (!hasBranchAccess(session, branchId)) {
    throw new ForbiddenError("You do not have access to this branch");
  }
}
