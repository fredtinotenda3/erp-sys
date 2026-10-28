import { CustomerForm } from "../../../../../components/features/customers/customer-form";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { getCustomerById } from "../../../../../src/server/modules/customers/customer-service";
import { getPageContext, load } from "../../../../../lib/server/page-context";

export const metadata = { title: "Edit customer · Operis" };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("customer:update")) return <AccessDenied what="customer editing" />;
  const { id } = await params;
  const c = await load<{ id: string; name: string; status: "active" | "inactive"; contact: string | null; address: string | null; notes: string | null }>(() => getCustomerById(ctx.session, id));
  if (!c.ok) return <LoadFailure status={c.status} message={c.message} what="this customer" />;
  return (
    <>
      <PageHeader title={`Edit ${c.data.name}`} crumbs={[{ label: "Customers", href: "/customers" }, { label: c.data.name, href: `/customers/${c.data.id}` }, { label: "Edit" }]} />
      <CustomerForm customer={c.data} />
    </>
  );
}
