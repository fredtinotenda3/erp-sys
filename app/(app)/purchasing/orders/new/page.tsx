import { PurchaseOrderForm } from "../../../../../components/features/purchasing/purchase-order-form";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, ErrorState } from "../../../../../components/ui/states";
import { RECEIVABLE } from "../../../../../lib/labels";
import { getPageContext } from "../../../../../lib/server/page-context";
import { loadCurrencies, loadItems, loadSuppliers } from "../../../../../lib/server/lookups";

export const metadata = { title: "New purchase order · Operis" };

export default async function NewPurchaseOrderPage() {
  const ctx = await getPageContext();
  if (!ctx.can("purchase_order:create")) return <AccessDenied what="purchase order creation" />;
  if (!ctx.can("supplier:read") || !ctx.can("item:read")) return <AccessDenied what="the suppliers and items needed to create a purchase order" />;

  const [items, suppliers, currencies] = await Promise.all([loadItems(ctx, { isActive: true }), loadSuppliers(ctx), loadCurrencies()]);
  if (!items.available || !suppliers.available) return <ErrorState message="The supplier or item list couldn't be loaded. Try again in a moment." />;

  return (
    <>
      <PageHeader title="New purchase order" crumbs={[{ label: "Purchasing", href: "/purchasing/orders" }, { label: "New purchase order" }]} description="The purchase order is saved as a draft. Nothing can be received against it until you confirm it." />
      <PurchaseOrderForm
        branches={ctx.me.branches}
        suppliers={suppliers.list.filter((s) => s.status === "active").map((s) => ({ id: s.id, name: s.name }))}
        products={items.list.filter((i) => RECEIVABLE.includes(i.itemType)).map((i) => ({ id: i.id, name: i.name, sku: i.sku, uom: i.uom }))}
        currencies={currencies}
        defaultBranchId={ctx.selectedBranchId}
      />
    </>
  );
}
