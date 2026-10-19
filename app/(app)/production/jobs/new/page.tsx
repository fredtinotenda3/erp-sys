import { JobForm } from "../../../../../components/features/production/job-form";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, ErrorState } from "../../../../../components/ui/states";
import { PRODUCIBLE } from "../../../../../lib/labels";
import { getPageContext } from "../../../../../lib/server/page-context";
import { loadCurrencies, loadCustomers, loadItems } from "../../../../../lib/server/lookups";

export const metadata = { title: "New production job · Operis" };

export default async function NewJobPage() {
  const ctx = await getPageContext();
  if (!ctx.can("production_job:create") || !ctx.can("item:read")) return <AccessDenied what="job creation" />;

  const showCost = ctx.can("cost:read");
  const [items, customers, currencies] = await Promise.all([loadItems(ctx, { isActive: true }), loadCustomers(ctx), showCost ? loadCurrencies() : Promise.resolve([])]);
  if (!items.available) return <ErrorState message="The product list couldn't be loaded. Try again in a moment." />;

  const products = items.list.filter((i) => PRODUCIBLE.includes(i.itemType)).map((i) => ({ id: i.id, name: i.name, sku: i.sku, uom: i.uom }));
  const materialNames = Object.fromEntries(items.list.map((i) => [i.id, `${i.name} (${i.sku})`]));

  return (
    <>
      <PageHeader title="New production job" crumbs={[{ label: "Production", href: "/production/jobs" }, { label: "New job" }]} description="The job number is assigned automatically and never changes." />
      <JobForm
        branches={ctx.me.branches}
        products={products}
        customers={customers.available ? customers.list.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name })) : null}
        currencies={currencies}
        canSeeCost={showCost}
        defaultBranchId={ctx.selectedBranchId}
        materialNames={materialNames}
      />
    </>
  );
}
