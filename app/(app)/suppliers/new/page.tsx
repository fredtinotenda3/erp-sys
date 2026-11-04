import { SupplierForm } from "../../../../components/features/suppliers/supplier-form";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied } from "../../../../components/ui/states";
import { getPageContext } from "../../../../lib/server/page-context";

export const metadata = { title: "New supplier · Operis" };

export default async function NewSupplierPage() {
  const ctx = await getPageContext();
  if (!ctx.can("supplier:create")) return <AccessDenied what="supplier creation" />;
  return (
    <>
      <PageHeader title="New supplier" crumbs={[{ label: "Suppliers", href: "/suppliers" }, { label: "New supplier" }]} />
      <SupplierForm />
    </>
  );
}
