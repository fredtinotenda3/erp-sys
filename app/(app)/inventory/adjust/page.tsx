import { AdjustForm } from "../../../../components/features/inventory/adjust-form";
import { PageHeader } from "../../../../components/ui/page-header";
import { Notice } from "../../../../components/ui/notice";
import { AccessDenied, ErrorState } from "../../../../components/ui/states";
import { getPageContext } from "../../../../lib/server/page-context";
import { loadCurrencies, loadItems, loadWarehouses } from "../../../../lib/server/lookups";

export const metadata = { title: "Adjust stock · Operis" };

export default async function AdjustPage() {
  const ctx = await getPageContext();
  if (!ctx.can("stock:adjust") || !ctx.can("item:read")) return <AccessDenied what="stock adjustments" />;
  const [items, warehouses, currencies] = await Promise.all([loadItems(ctx, { isActive: true }), loadWarehouses(ctx), loadCurrencies()]);
  if (!items.available || !warehouses.available || currencies.length === 0) return <ErrorState message="The items, warehouses or currencies needed for this form couldn't be loaded. Try again in a moment." />;

  const whs = warehouses.list.filter((w) => w.isActive && (!ctx.selectedBranchId || w.branchId === ctx.selectedBranchId));
  return (
    <>
      <PageHeader title="Adjust stock" crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Adjust stock" }]} description="Correct a balance after a count or a write-off. Every adjustment needs a reason and is permanent." />
      {whs.length === 0 ? (
        <Notice tone="warning">There is no active warehouse to adjust.</Notice>
      ) : (
        <AdjustForm
          items={items.list.map((i) => ({ id: i.id, label: `${i.name} (${i.sku})`, uom: i.uom }))}
          warehouses={whs.map((w) => ({ id: w.id, name: ctx.me.branches.length > 1 ? `${w.name} — ${ctx.branchName(w.branchId)}` : w.name }))}
          currencies={currencies}
          canSeeCost={ctx.can("cost:read")}
        />
      )}
    </>
  );
}
