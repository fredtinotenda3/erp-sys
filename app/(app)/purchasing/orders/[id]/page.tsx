import Link from "next/link";
import { Pencil, Truck } from "lucide-react";

import { PurchaseOrderActions } from "../../../../../components/features/purchasing/purchase-order-actions";
import { buttonVariants } from "../../../../../components/ui/button";
import { Card } from "../../../../../components/ui/card";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../../components/ui/provenance";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../../components/ui/states";
import { PurchaseOrderStatusBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { getPurchaseOrder } from "../../../../../src/server/modules/purchasing/purchase-order-service";
import { listGoodsReceiptsForPo } from "../../../../../src/server/modules/purchasing/goods-receipt-service";
import { formatDate, formatDateTimeLocal } from "../../../../../lib/format";
import { getPageContext, load } from "../../../../../lib/server/page-context";

export const metadata = { title: "Purchase order · Operis" };

interface Po {
  id: string; poNumber: string; branchId: string; status: string; currency: string; total?: string; requestedDeliveryDate: string | null; supplierReference: string | null; notes: string | null; createdAt: string; updatedAt: string;
  supplier: { id: string; name: string; status: string };
  lines: { id: string; itemId: string; sku: string; itemName: string; uom: string; quantity: string; unitPrice?: string; lineTotal?: string; currency: string; receivedQty: string; outstandingQty: string }[];
}

interface ReceiptRow {
  id: string;
  deliveryReference: string | null;
  receivedAt: string;
  lines: { id: string; sku: string; itemName: string; receivedQty: string; acceptedQty: string; rejectedQty: string; rejectReason: string | null }[];
}

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("purchase_order:read")) return <AccessDenied what="purchase orders" />;
  const { id } = await params;
  const res = await load<Po>(() => getPurchaseOrder(ctx.session, id));
  if (!res.ok) return <LoadFailure status={res.status} message={res.message} what="this purchase order" />;
  const o = res.data;

  const canSeeCost = ctx.can("cost:read");
  const canSeeReceipts = ctx.can("goods_receipt:read");
  const receipts = canSeeReceipts ? await load<ReceiptRow[]>(() => listGoodsReceiptsForPo(ctx.session, id)) : null;

  const canReceive = (o.status === "confirmed" || o.status === "partially_received") && ctx.can("goods_receipt:create");
  const hasOutstanding = o.lines.some((l) => Number(l.outstandingQty) > 0);

  return (
    <>
      <PageHeader
        title={<>{o.poNumber} <PurchaseOrderStatusBadge status={o.status} /></>}
        crumbs={[{ label: "Purchasing", href: "/purchasing/orders" }, { label: o.poNumber }]}
        meta={<>
          <span>Supplier: {ctx.can("supplier:read") ? <Link href={`/suppliers/${o.supplier.id}`} className="text-primary hover:underline">{o.supplier.name}</Link> : o.supplier.name}</span>
          <span>Branch: {ctx.branchName(o.branchId)}</span>
          <span>Delivery requested: {formatDate(o.requestedDeliveryDate)}</span>
          <span>Created {formatDateTimeLocal(o.createdAt)}</span>
          {o.supplierReference ? <span>Supplier ref: {o.supplierReference}</span> : null}
        </>}
        actions={<>
          {o.status === "draft" && ctx.can("purchase_order:update") ? <Link href={`/purchasing/orders/${o.id}/edit`} className={buttonVariants({ variant: "outline" })}><Pencil /> Edit draft</Link> : null}
          {canReceive && hasOutstanding ? <Link href={`/purchasing/orders/${o.id}/receive`} className={buttonVariants()}><Truck /> Receive goods</Link> : null}
          <PurchaseOrderActions orderId={o.id} poNumber={o.poNumber} status={o.status} canConfirm={ctx.can("purchase_order:confirm")} canUpdate={ctx.can("purchase_order:update")} />
        </>}
      />

      {o.status === "draft" ? <Notice tone="info" className="mb-4">This order is a draft. Confirm it to allow goods to be received against it.</Notice> : null}
      {(o.status === "confirmed" || o.status === "partially_received") && !hasOutstanding ? <Notice tone="info" className="mb-4">Everything on this order has been accounted for. Close it once you&apos;re done, or it will stay open indefinitely.</Notice> : null}
      {o.status === "cancelled" ? <Notice tone="warning" className="mb-4">This order was cancelled. The reason is recorded in the audit log.</Notice> : null}
      {o.status === "closed" ? <Notice tone="info" className="mb-4">This order is closed. No more goods can be received against it.</Notice> : null}
      {o.notes ? <Notice tone="info" className="mb-4">{o.notes}</Notice> : null}

      <Card className="mb-5">
        <Table>
          <THead>
            <tr><TH>Item</TH><TH className="text-right">Ordered</TH>{canSeeCost ? <><TH className="text-right">Unit price</TH><TH className="text-right">Line total</TH></> : null}<TH className="text-right">Received</TH><TH className="text-right">Outstanding</TH></tr>
          </THead>
          <TBody>
            {o.lines.map((l) => (
              <TR key={l.id}>
                <TD><span className="font-medium">{l.itemName}</span><span className="block text-xs text-muted-foreground">{l.sku}</span></TD>
                <TD className="text-right"><Quantity value={l.quantity} uom={l.uom} /></TD>
                {canSeeCost ? (
                  <>
                    <TD className="text-right">{l.unitPrice !== undefined ? <Money amount={l.unitPrice} currency={l.currency} /> : "—"}</TD>
                    <TD className="text-right">{l.lineTotal !== undefined ? <Money amount={l.lineTotal} currency={l.currency} /> : "—"}</TD>
                  </>
                ) : null}
                <TD className="text-right"><Quantity value={l.receivedQty} uom={l.uom} /></TD>
                <TD className="text-right"><Quantity value={l.outstandingQty} uom={l.uom} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {canSeeCost && o.total !== undefined ? <p className="border-t border-border px-4 py-3 text-right text-sm">Order total (no tax or discounts): <strong><Money amount={o.total} currency={o.currency} /></strong></p> : null}
      </Card>

      {receipts ? (
        <section aria-labelledby="receipts-h">
          <h2 id="receipts-h" className="mb-2 text-sm font-semibold">Goods receipts</h2>
          {!receipts.ok ? (
            <ErrorState title="Receipts couldn't be loaded" message={receipts.message} />
          ) : receipts.data.length === 0 ? (
            <Card className="p-4 text-sm text-muted-foreground">Nothing has been received against this order yet.</Card>
          ) : (
            <div className="space-y-3">
              {receipts.data.map((r) => (
                <Card key={r.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm">
                    <span>
                      Received {formatDateTimeLocal(r.receivedAt)}
                      {r.deliveryReference ? <span className="text-muted-foreground"> — ref {r.deliveryReference}</span> : null}
                    </span>
                  </div>
                  <Table>
                    <THead><tr><TH>Item</TH><TH className="text-right">Received</TH><TH className="text-right">Accepted</TH><TH className="text-right">Rejected</TH><TH>Reason</TH></tr></THead>
                    <TBody>
                      {r.lines.map((l) => (
                        <TR key={l.id}>
                          <TD><span className="font-medium">{l.itemName}</span><span className="block text-xs text-muted-foreground">{l.sku}</span></TD>
                          <TD className="text-right">{l.receivedQty}</TD>
                          <TD className="text-right">{l.acceptedQty}</TD>
                          <TD className="text-right">{l.rejectedQty}</TD>
                          <TD>{l.rejectReason ?? "—"}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
