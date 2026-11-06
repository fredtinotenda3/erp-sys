import { redirect } from "next/navigation";

import { DispatchForm, type DispatchableLine } from "../../../../../components/features/sales/dispatch-form";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../../components/ui/states";
import { getSalesOrder } from "../../../../../src/server/modules/sales/sales-order-service";
import { getPageContext, load } from "../../../../../lib/server/page-context";
import { loadWarehouses } from "../../../../../lib/server/lookups";

export const metadata = { title: "Dispatch order · Operis" };

type OrderData = {
  id: string;
  orderNumber: string;
  branchId: string;
  status: string;
  lines: { id: string; itemId: string; sku: string; itemName: string; uom: string; remainingToDispatchQty: string }[];
};

// Mirrors purchasing/orders/[id]/receive/page.tsx exactly, for the
// symmetric sales-side operation: fulfilling a confirmed order from
// finished-goods stock instead of receiving against a purchase order.
export default async function DispatchOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("sales_order:read") || !ctx.can("dispatch:create")) return <AccessDenied what="dispatching orders" />;
  const { id } = await params;
  const order = await load<OrderData>(() => getSalesOrder(ctx.session, id));
  if (!order.ok) return <LoadFailure status={order.status} message={order.message} what="this order" />;
  const o = order.data;
  // Only confirmed / in-production / partially-delivered orders can take a
  // dispatch; the server enforces this too. A direct link to this page in
  // the wrong state (e.g. a stale bookmark) just bounces back to the order.
  if (o.status !== "confirmed" && o.status !== "in_production" && o.status !== "partially_delivered") redirect(`/orders/${id}`);

  const warehouses = await loadWarehouses(ctx);
  if (!warehouses.available) return <ErrorState message="The warehouse list couldn't be loaded. Try again in a moment." />;
  const whs = warehouses.list.filter((w) => w.isActive && w.branchId === o.branchId);

  const dispatchableLines: DispatchableLine[] = o.lines
    .filter((l) => Number(l.remainingToDispatchQty) > 0)
    .map((l) => ({ id: l.id, itemId: l.itemId, sku: l.sku, itemName: l.itemName, uom: l.uom, remainingToDispatchQty: l.remainingToDispatchQty }));

  if (dispatchableLines.length === 0) redirect(`/orders/${id}`); // nothing left to dispatch -- the order page's own notice explains why

  return (
    <>
      <PageHeader
        title={`Dispatch ${o.orderNumber}`}
        crumbs={[{ label: "Orders", href: "/orders" }, { label: o.orderNumber, href: `/orders/${o.id}` }, { label: "Dispatch" }]}
        description="Ship outstanding lines from finished-goods stock. Which batch each line is picked from is chosen automatically (oldest first) and recorded on the dispatch for full traceability."
      />
      {whs.length === 0 ? (
        <ErrorState message="There is no active warehouse in this order's branch to dispatch from. Add one under Inventory → Warehouses." />
      ) : (
        <DispatchForm orderId={o.id} orderNumber={o.orderNumber} lines={dispatchableLines} warehouses={whs.map((w) => ({ id: w.id, name: w.name }))} />
      )}
    </>
  );
}
