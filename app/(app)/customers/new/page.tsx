import { CustomerForm } from "../../../../components/features/customers/customer-form";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied } from "../../../../components/ui/states";
import { getPageContext } from "../../../../lib/server/page-context";

export const metadata = { title: "New customer · Operis" };

export default async function NewCustomerPage() {
  const ctx = await getPageContext();
  if (!ctx.can("customer:create")) return <AccessDenied what="customer creation" />;
  return (
    <>
      <PageHeader title="New customer" crumbs={[{ label: "Customers", href: "/customers" }, { label: "New customer" }]} />
      <CustomerForm />
    </>
  );
}
