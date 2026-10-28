import { OrderForm } from "../../../../components/features/orders/order-form";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, ErrorState } from "../../../../components/ui/states";
import { getPageContext } from "../../../../lib/server/page-context";
import { loadCurrencies, loadCustomers, loadItems } from "../../../../lib/server/lookups";

export const metadata = { title: "New sales order · Operis" };

export default async function NewOrderPage() {
  const ctx = await getPageContext();
  if (!ctx.can("sales_order:create")) return <AccessDenied what="order creation" />;
  if (!ctx.can("customer:read") || !ctx.can("item:read")) return <AccessDenied what="the customers and products needed to create an order" />;

  const [items, customers, currencies] = await Promise.all([loadItems(ctx, { isActive: true }), loadCustomers(ctx), loadCurrencies()]);
  if (!items.available || !customers.available) return <ErrorState message="The customer or product list couldn't be loaded. Try again in a moment." />;

  return (
    <>
      <PageHeader title="New sales order" crumbs={[{ label: "Orders", href: "/orders" }, { label: "New order" }]} description="The order is saved as a draft. Nothing is released to production until you confirm it and release its lines." />
      <OrderForm
        branches={ctx.me.branches}
        customers={customers.list.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))}
        products={items.list.filter((i) => i.itemType === "finished_good").map((i) => ({ id: i.id, name: i.name, sku: i.sku, uom: i.uom }))}
        currencies={currencies}
        defaultBranchId={ctx.selectedBranchId}
      />
    </>
  );
}
