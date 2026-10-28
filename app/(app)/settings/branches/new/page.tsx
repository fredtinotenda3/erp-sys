import { NewBranchForm } from "../../../../../components/features/settings/branch-forms";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied } from "../../../../../components/ui/states";
import { getPageContext } from "../../../../../lib/server/page-context";

export const metadata = { title: "New branch · Operis" };

export default async function NewBranchPage() {
  const ctx = await getPageContext();
  if (!ctx.can("branch:create")) return <AccessDenied what="branch creation" />;
  return (
    <>
      <PageHeader title="New branch" crumbs={[{ label: "Settings", href: "/settings/branches" }, { label: "New branch" }]} description="Creating a branch gives you access to it automatically. Grant others access from their user page." />
      <NewBranchForm />
    </>
  );
}
