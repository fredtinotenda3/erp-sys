import { redirect } from "next/navigation";

import { PurchaseOrderForm, type PurchaseOrderFormOrder } from "../../../../../../components/features/purchasing/purchase-order-form";
import { PageHeader } from "../../../../../../components/ui/page-header";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../../../components/ui/states";
import { getPurchaseOrder } from "../../../../../../src/server/modules/purchasing/purchase-order-service";
import { getPageContext, load } from "../../../../../../lib/server/page-context";
import { loadCurrencies, loadItems, loadSuppliers } from "../../../../../../lib/server/lookups";
import { RECEIVABLE } from "../../../../../../lib/labels";

export const metadata = { title: "Edit draft purchase order · Operis" };

type PoData = {
  id: string;
  poNumber: string;
  branchId: string;
  status: string;
  currency: string;
  requestedDeliveryDate: string | null;
  supplierReference: string | null;
  notes: string | null;
  supplier: { id: string };
  lines: { itemId: string; quantity: string; uom: string; unitPrice: string }[];
};

export default async function EditPurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("purchase_order:update") || !ctx.can("supplier:read") || !ctx.can("item:read")) return <AccessDenied what="purchase order editing" />;
  const { id } = await params;
  const order = await load<PoData>(() => getPurchaseOrder(ctx.session, id));
  if (!order.ok) return <LoadFailure status={order.status} message={order.message} what="this purchase order" />;
  if (order.data.status !== "draft") redirect(`/purchasing/orders/${id}`); // only drafts are editable; the server enforces it too

  const [items, suppliers, currencies] = await Promise.all([loadItems(ctx, { isActive: true }), loadSuppliers(ctx), loadCurrencies()]);
  if (!items.available || !suppliers.available) return <ErrorState message="The supplier or item list couldn't be loaded. Try again in a moment." />;
  const o = order.data;
  const initial: PurchaseOrderFormOrder = {
    id: o.id,
    branchId: o.branchId,
    supplierId: o.supplier.id,
    currency: o.currency,
    requestedDeliveryDate: o.requestedDeliveryDate,
    supplierReference: o.supplierReference,
    notes: o.notes,
    lines: o.lines,
  };

  return (
    <>
      <PageHeader title={`Edit ${o.poNumber}`} crumbs={[{ label: "Purchasing", href: "/purchasing/orders" }, { label: o.poNumber, href: `/purchasing/orders/${o.id}` }, { label: "Edit" }]} />
      <PurchaseOrderForm
        branches={ctx.me.branches}
        suppliers={suppliers.list.filter((s) => s.status === "active" || s.id === o.supplier.id).map((s) => ({ id: s.id, name: s.name }))}
        products={items.list.filter((i) => RECEIVABLE.includes(i.itemType)).map((i) => ({ id: i.id, name: i.name, sku: i.sku, uom: i.uom }))}
        currencies={currencies}
        defaultBranchId={null}
        order={initial}
      />
    </>
  );
}
