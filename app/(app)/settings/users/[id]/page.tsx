import { UserAdminPanel } from "../../../../../components/features/settings/user-forms";
import { Card } from "../../../../../components/ui/card";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { ActiveBadge } from "../../../../../components/ui/status-badge";
import { getUser } from "../../../../../src/server/modules/iam/user-service";
import { capabilitiesFor, ROLE_VALUES, type Role } from "../../../../../src/server/shared/authz";
import { formatDate, humanize } from "../../../../../lib/format";
import { getPageContext, load } from "../../../../../lib/server/page-context";

export const metadata = { title: "User · Operis" };

type U = { id: string; fullName: string; email: string; role: Role; isActive: boolean; createdAt: string; implicitAllBranches: boolean; branchAccess: { branchId: string; name: string }[] };

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("user:read")) return <AccessDenied what="user administration" />;
  const { id } = await params;
  const res = await load<U>(() => getUser(ctx.session, id));
  if (!res.ok) return <LoadFailure status={res.status} message={res.message} what="this user" />;
  const u = res.data;
  const isOwner = ctx.session.role === "OWNER_ADMIN";
  const assignable = ROLE_VALUES.filter((r) => r !== "OWNER_ADMIN" || isOwner);
  // The target's capabilities are read from the same table the server enforces.
  const caps = capabilitiesFor(u.role);
  const have = new Set(u.branchAccess.map((b) => b.branchId));
  const target = u.role === "OWNER_ADMIN" && !isOwner; // a manager can't change an owner

  return (
    <>
      <PageHeader title={<>{u.fullName} <ActiveBadge active={u.isActive} /></>} crumbs={[{ label: "Settings", href: "/settings/users" }, { label: u.fullName }]} meta={<><span>{u.email}</span><span>{humanize(u.role.toLowerCase())}</span><span>Added {formatDate(u.createdAt)}</span></>} />
      <UserAdminPanel
        user={{ id: u.id, fullName: u.fullName, role: u.role, isActive: u.isActive, implicitAllBranches: u.implicitAllBranches, branchAccess: u.branchAccess }}
        assignableRoles={[...assignable]}
        canChangeRole={ctx.can("user:update_role") && !target}
        canDeactivate={ctx.can("user:deactivate") && !target && u.id !== ctx.session.userId}
        canGrant={ctx.can("branch_access:grant")}
        canRevoke={ctx.can("branch_access:revoke")}
        grantableBranches={ctx.me.branches.filter((b) => !have.has(b.id))}
      />
      <Card className="mt-5 p-4">
        <h2 className="mb-2 text-sm font-semibold">What the {humanize(u.role.toLowerCase())} role can do</h2>
        <ul className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
          {caps.map((c) => <li key={c}><code>{c}</code></li>)}
        </ul>
      </Card>
    </>
  );
}
