import { redirect } from "next/navigation";

import { OrderForm, type OrderFormOrder } from "../../../../../components/features/orders/order-form";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../../components/ui/states";
import { getSalesOrder } from "../../../../../src/server/modules/sales/sales-order-service";
import { getPageContext, load } from "../../../../../lib/server/page-context";
import { loadCurrencies, loadCustomers, loadItems } from "../../../../../lib/server/lookups";

export const metadata = { title: "Edit draft order · Operis" };

type OrderData = { id: string; orderNumber: string; branchId: string; status: string; currency: string; requestedDeliveryDate: string | null; customer: { id: string }; lines: { itemId: string; quantity: string; unitPrice: string }[] };

export default async function EditOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("sales_order:update") || !ctx.can("customer:read") || !ctx.can("item:read")) return <AccessDenied what="order editing" />;
  const { id } = await params;
  const order = await load<OrderData>(() => getSalesOrder(ctx.session, id));
  if (!order.ok) return <LoadFailure status={order.status} message={order.message} what="this order" />;
  if (order.data.status !== "draft") redirect(`/orders/${id}`); // only drafts are editable; the server enforces it too

  const [items, customers, currencies] = await Promise.all([loadItems(ctx, { isActive: true }), loadCustomers(ctx), loadCurrencies()]);
  if (!items.available || !customers.available) return <ErrorState message="The customer or product list couldn't be loaded. Try again in a moment." />;
  const o = order.data;
  const initial: OrderFormOrder = { id: o.id, branchId: o.branchId, customerId: o.customer.id, currency: o.currency, requestedDeliveryDate: o.requestedDeliveryDate, lines: o.lines };

  return (
    <>
      <PageHeader title={`Edit ${o.orderNumber}`} crumbs={[{ label: "Orders", href: "/orders" }, { label: o.orderNumber, href: `/orders/${o.id}` }, { label: "Edit" }]} />
      <OrderForm
        branches={ctx.me.branches}
        customers={customers.list.filter((c) => c.status === "active" || c.id === o.customer.id).map((c) => ({ id: c.id, name: c.name }))}
        products={items.list.filter((i) => i.itemType === "finished_good").map((i) => ({ id: i.id, name: i.name, sku: i.sku, uom: i.uom }))}
        currencies={currencies}
        defaultBranchId={null}
        order={initial}
      />
    </>
  );
}
