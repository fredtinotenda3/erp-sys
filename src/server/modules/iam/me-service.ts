// "Who am I, right now" — the one read in this codebase that deliberately
// has NO capability check. Every other *read* function in every module
// (listItems, listCustomers, listAuditLog, ...) asserts a capability
// before returning data, because it's reading something that isn't
// inherently the caller's own. This function only ever returns the
// calling session's OWN user record and OWN organization's name — there
// is no role for which "see your own name and the name of the org you're
// logged into" is a privileged operation; every authenticated session,
// regardless of role, needs this to render the app shell's user menu and
// top bar. If you ever find yourself tempted to add a second field here
// that belongs to someone else (another user's name, another org's data),
// that belongs behind its own capability-checked function instead — don't
// widen this one.
import { prisma } from "../../shared/db";
import type { AuthenticatedSession } from "./session-service";
import { listBranches } from "./branch-service";

export interface CurrentUserDisplay {
  userId: string;
  fullName: string;
  email: string;
  orgId: string;
  orgName: string;
  // Branches this session can act in — OWNER_ADMIN's implicit all-branch
  // access already resolved by listBranches(), not re-derived here. Used
  // for the top bar's branch switcher (§12.2: "only rendered for users
  // with multi-branch access"; single-branch users render branches[0].name
  // as static text).
  branches: { id: string; name: string }[];
}

export async function getCurrentUserDisplay(session: AuthenticatedSession): Promise<CurrentUserDisplay> {
  const [user, org, branches] = await Promise.all([
    prisma.user.findFirst({
      where: { orgId: session.orgId, id: session.userId },
      select: { fullName: true, email: true },
    }),
    prisma.organization.findUnique({ where: { id: session.orgId }, select: { name: true } }),
    listBranches(session),
  ]);

  // Both lookups are by the session's own validated ids — a miss here
  // means the session itself has gone stale between validation and this
  // call (e.g. the user or org row vanished mid-request), not a "not
  // found" in the ordinary sense. There is no sensible partial result to
  // return, so this is a hard failure rather than a NotFoundError the
  // route layer would otherwise map to a misleading 404.
  if (!user || !org) {
    throw new Error("Authenticated session refers to a user or organization that no longer resolves");
  }

  return {
    userId: session.userId,
    fullName: user.fullName,
    email: user.email,
    orgId: session.orgId,
    orgName: org.name,
    branches: branches.map((b) => ({ id: b.id, name: b.name })),
  };
}
