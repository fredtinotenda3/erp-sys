import Link from "next/link";
import { Plus } from "lucide-react";

import { listUsers } from "../../../../src/server/modules/iam/user-service";
import { SettingsNav } from "../../../../components/features/settings/settings-nav";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { ActiveBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { humanize } from "../../../../lib/format";
import { getPageContext, load } from "../../../../lib/server/page-context";

export const metadata = { title: "Users · Operis" };

export default async function UsersPage() {
  const ctx = await getPageContext();
  if (!ctx.can("user:read")) return <AccessDenied what="user administration" />;
  const users = await load<{ id: string; fullName: string; email: string; role: string; isActive: boolean }[]>(() => listUsers(ctx.session));
  return (
    <>
      <PageHeader title="Settings" actions={ctx.can("user:create") ? <Link href="/settings/users/new" className={buttonVariants()}><Plus /> New user</Link> : null} />
      <SettingsNav role={ctx.session.role} active="users" />
      {!users.ok ? <LoadFailure status={users.status} message={users.message} what="users" /> : users.data.length === 0 ? <EmptyState title="No users" /> : (
        <Card>
          <Table>
            <THead><tr><TH>Name</TH><TH>Email</TH><TH>Role</TH><TH>Status</TH></tr></THead>
            <TBody>
              {users.data.map((u) => (
                <TR key={u.id}>
                  <TD><Link href={`/settings/users/${u.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{u.fullName}</Link></TD>
                  <TD>{u.email}</TD>
                  <TD>{humanize(u.role.toLowerCase())}</TD>
                  <TD><ActiveBadge active={u.isActive} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
