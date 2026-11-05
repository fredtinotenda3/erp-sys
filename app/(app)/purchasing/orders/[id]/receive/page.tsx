import { redirect } from "next/navigation";

import { GoodsReceiptForm, type ReceivableLine } from "../../../../../../components/features/purchasing/goods-receipt-form";
import { PageHeader } from "../../../../../../components/ui/page-header";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../../../components/ui/states";
import { getPurchaseOrder } from "../../../../../../src/server/modules/purchasing/purchase-order-service";
import { getPageContext, load } from "../../../../../../lib/server/page-context";
import { loadWarehouses } from "../../../../../../lib/server/lookups";

export const metadata = { title: "Receive goods · Operis" };

type PoData = {
  id: string;
  poNumber: string;
  branchId: string;
  status: string;
  lines: { id: string; itemId: string; sku: string; itemName: string; uom: string; outstandingQty: string }[];
};

export default async function ReceiveGoodsPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("purchase_order:read") || !ctx.can("goods_receipt:create")) return <AccessDenied what="goods receiving" />;
  const { id } = await params;
  const order = await load<PoData>(() => getPurchaseOrder(ctx.session, id));
  if (!order.ok) return <LoadFailure status={order.status} message={order.message} what="this purchase order" />;
  const o = order.data;
  // Only confirmed / partially-received orders can take a receipt; the
  // server enforces this too. A direct link to this page in the wrong state
  // (e.g. a stale bookmark) just bounces back to the order itself.
  if (o.status !== "confirmed" && o.status !== "partially_received") redirect(`/purchasing/orders/${id}`);

  const warehouses = await loadWarehouses(ctx);
  if (!warehouses.available) return <ErrorState message="The warehouse list couldn't be loaded. Try again in a moment." />;
  const whs = warehouses.list.filter((w) => w.isActive && w.branchId === o.branchId);

  const receivableLines: ReceivableLine[] = o.lines
    .filter((l) => Number(l.outstandingQty) > 0)
    .map((l) => ({ id: l.id, itemId: l.itemId, sku: l.sku, itemName: l.itemName, uom: l.uom, outstandingQty: l.outstandingQty }));

  if (receivableLines.length === 0) redirect(`/purchasing/orders/${id}`); // nothing left to receive -- the detail page's own notice explains why

  return (
    <>
      <PageHeader
        title={`Receive goods against ${o.poNumber}`}
        crumbs={[{ label: "Purchasing", href: "/purchasing/orders" }, { label: o.poNumber, href: `/purchasing/orders/${o.id}` }, { label: "Receive goods" }]}
        description="Record what actually arrived, inspect it, and post the accepted quantity into stock. Rejected units never enter inventory."
      />
      {whs.length === 0 ? (
        <ErrorState message="There is no active warehouse in this order's branch to receive into. Add one under Inventory → Warehouses." />
      ) : (
        <GoodsReceiptForm poId={o.id} poNumber={o.poNumber} lines={receivableLines} warehouses={whs.map((w) => ({ id: w.id, name: w.name }))} />
      )}
    </>
  );
}
