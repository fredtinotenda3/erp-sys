import Link from "next/link";
import { Plus } from "lucide-react";

import { listBranches } from "../../../../src/server/modules/iam/branch-service";
import { SettingsNav } from "../../../../components/features/settings/settings-nav";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { ActiveBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { getPageContext, load } from "../../../../lib/server/page-context";

export const metadata = { title: "Branches · Operis" };

export default async function BranchesPage() {
  const ctx = await getPageContext();
  if (!ctx.can("branch:read")) return <AccessDenied what="branches" />;
  const branches = await load<{ id: string; name: string; isActive: boolean }[]>(() => listBranches(ctx.session));
  return (
    <>
      <PageHeader title="Settings" actions={ctx.can("branch:create") ? <Link href="/settings/branches/new" className={buttonVariants()}><Plus /> New branch</Link> : null} />
      <SettingsNav role={ctx.session.role} active="branches" />
      {!branches.ok ? <LoadFailure status={branches.status} message={branches.message} what="branches" /> : branches.data.length === 0 ? <EmptyState title="No branches" /> : (
        <Card>
          <Table>
            <THead><tr><TH>Branch</TH><TH>Status</TH></tr></THead>
            <TBody>
              {branches.data.map((b) => (
                <TR key={b.id}>
                  <TD><Link href={`/settings/branches/${b.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{b.name}</Link></TD>
                  <TD><ActiveBadge active={b.isActive} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
