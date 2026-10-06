// Tenant/branch scope types. These exist to make the mandatory scoping
// discipline visible in function signatures — `server/modules/*` functions
// that touch org-owned data take a Scope (or a session, which carries one;
// see modules/iam/session-service.ts's AuthenticatedSession) as an explicit
// parameter, never rely on an ambient "current org" global or a bare
// `id` lookup. See ARCHITECTURE.md Section 6.
//
// The actual tenant-isolation guarantee is NOT this type — TypeScript types
// vanish at runtime. The guarantee is the pattern enforced by convention and
// exercised by the isolation tests: every Prisma query against an org-owned
// table includes `orgId` in its `where` clause, and every mutation target is
// first fetched scoped by `orgId` (via findFirst) before being acted on by
// its bare `id`. This file just gives that pattern a name to put in a type
// signature so a reviewer can see at a glance which functions are
// tenant-scoped.

export interface OrgScope {
  readonly orgId: string;
}

export interface BranchScope extends OrgScope {
  readonly branchId: string;
}
