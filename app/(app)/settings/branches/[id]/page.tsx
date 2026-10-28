import Link from "next/link";

import { DeactivateBranchButton } from "../../../../../components/features/settings/branch-forms";
import { Card } from "../../../../../components/ui/card";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { ActiveBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { getBranchDetail } from "../../../../../src/server/modules/iam/branch-service";
import { formatDate, humanize } from "../../../../../lib/format";
import { getPageContext, load } from "../../../../../lib/server/page-context";

export const metadata = { title: "Branch · Operis" };

type B = { id: string; name: string; isActive: boolean; createdAt: string; members: { id: string; fullName: string; email: string; role: string; isActive: boolean; access: "implicit" | "granted" }[] };

export default async function BranchPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("branch:read")) return <AccessDenied what="branches" />;
  const { id } = await params;
  const res = await load<B>(() => getBranchDetail(ctx.session, id));
  if (!res.ok) return <LoadFailure status={res.status} message={res.message} what="this branch" />;
  const b = res.data;
  return (
    <>
      <PageHeader title={<>{b.name} <ActiveBadge active={b.isActive} /></>} crumbs={[{ label: "Settings", href: "/settings/branches" }, { label: b.name }]} meta={<span>Created {formatDate(b.createdAt)}</span>} actions={b.isActive && ctx.can("branch:deactivate") ? <DeactivateBranchButton branchId={b.id} name={b.name} /> : null} />
      {ctx.can("user:read") ? (
        <Card>
          <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">People with access</h2>
          <Table>
            <THead><tr><TH>Name</TH><TH>Role</TH><TH>Access</TH><TH>Status</TH></tr></THead>
            <TBody>
              {b.members.map((m) => (
                <TR key={m.id}>
                  <TD><Link href={`/settings/users/${m.id}`} className="font-medium text-primary hover:underline">{m.fullName}</Link><span className="block text-xs text-muted-foreground">{m.email}</span></TD>
                  <TD>{humanize(m.role.toLowerCase())}</TD>
                  <TD>{m.access === "implicit" ? "All branches (owner)" : "Granted"}</TD>
                  <TD><ActiveBadge active={m.isActive} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}
