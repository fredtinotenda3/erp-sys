import { SupplierForm } from "../../../../../components/features/suppliers/supplier-form";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { getSupplierById } from "../../../../../src/server/modules/suppliers/supplier-service";
import { getPageContext, load } from "../../../../../lib/server/page-context";

export const metadata = { title: "Edit supplier · Operis" };

export default async function EditSupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("supplier:update")) return <AccessDenied what="supplier editing" />;
  const { id } = await params;
  const s = await load<{ id: string; name: string; status: "active" | "inactive"; contact: string | null; address: string | null; notes: string | null }>(() => getSupplierById(ctx.session, id));
  if (!s.ok) return <LoadFailure status={s.status} message={s.message} what="this supplier" />;
  return (
    <>
      <PageHeader title={`Edit ${s.data.name}`} crumbs={[{ label: "Suppliers", href: "/suppliers" }, { label: s.data.name, href: `/suppliers/${s.data.id}` }, { label: "Edit" }]} />
      <SupplierForm supplier={s.data} />
    </>
  );
}
