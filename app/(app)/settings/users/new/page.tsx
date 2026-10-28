import { NewUserForm } from "../../../../../components/features/settings/user-forms";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied } from "../../../../../components/ui/states";
import { ROLE_VALUES } from "../../../../../src/server/shared/authz";
import { getPageContext } from "../../../../../lib/server/page-context";

export const metadata = { title: "New user · Operis" };

export default async function NewUserPage() {
  const ctx = await getPageContext();
  if (!ctx.can("user:create")) return <AccessDenied what="user creation" />;
  // Only OWNER_ADMIN may create another OWNER_ADMIN; the server enforces the same rule.
  const roles = ROLE_VALUES.filter((r) => r !== "OWNER_ADMIN" || ctx.session.role === "OWNER_ADMIN");
  return (
    <>
      <PageHeader title="New user" crumbs={[{ label: "Settings", href: "/settings/users" }, { label: "New user" }]} />
      <NewUserForm roles={[...roles]} branches={ctx.me.branches} />
    </>
  );
}
