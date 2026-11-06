import Link from "next/link";
import { Pencil, Truck } from "lucide-react";

import { OrderActions, ReleaseLineButton } from "../../../../components/features/orders/order-actions";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../components/ui/provenance";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../components/ui/states";
import { DispatchStatusBadge, JobStatusBadge, OrderStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { getSalesOrder } from "../../../../src/server/modules/sales/sales-order-service";
import { listDispatchesForOrder } from "../../../../src/server/modules/inventory/dispatch-service";
import { formatDate, formatDateTimeLocal } from "../../../../lib/format";
import { getPageContext, load } from "../../../../lib/server/page-context";
import type { Dispatch } from "../../../../lib/api-types";

export const metadata = { title: "Sales order · Operis" };

interface Order {
  id: string; orderNumber: string; branchId: string; status: string; currency: string; total: string; requestedDeliveryDate: string | null; createdAt: string; updatedAt: string;
  customer: { id: string; name: string };
  lines: { id: string; itemId: string; sku: string; itemName: string; uom: string; quantity: string; unitPrice: string; lineTotal: string; currency: string; dispatchedQty: string; remainingToDispatchQty: string; productionJob?: { id: string; jobNumber: string; status: string } | null }[];
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("sales_order:read")) return <AccessDenied what="sales orders" />;
  const { id } = await params;
  const res = await load<Order>(() => getSalesOrder(ctx.session, id));
  if (!res.ok) return <LoadFailure status={res.status} message={res.message} what="this order" />;
  const o = res.data;

  const showJobs = ctx.can("production_job:read");
  const canRelease = o.status === "confirmed" && ctx.can("production_job:create");
  const unreleased = o.lines.filter((l) => !l.productionJob).length;

  const canSeeDispatches = ctx.can("dispatch:read");
  const dispatches = canSeeDispatches ? await load<Dispatch[]>(() => listDispatchesForOrder(ctx.session, id)) : null;
  const canDispatch = (o.status === "confirmed" || o.status === "in_production" || o.status === "partially_delivered") && ctx.can("dispatch:create");
  const hasOutstandingToDispatch = o.lines.some((l) => Number(l.remainingToDispatchQty) > 0);

  return (
    <>
      <PageHeader
        title={<>{o.orderNumber} <OrderStatusBadge status={o.status} /></>}
        crumbs={[{ label: "Orders", href: "/orders" }, { label: o.orderNumber }]}
        meta={<>
          <span>Customer: {ctx.can("customer:read") ? <Link href={`/customers/${o.customer.id}`} className="text-primary hover:underline">{o.customer.name}</Link> : o.customer.name}</span>
          <span>Branch: {ctx.branchName(o.branchId)}</span>
          <span>Delivery requested: {formatDate(o.requestedDeliveryDate)}</span>
          <span>Created {formatDateTimeLocal(o.createdAt)}</span>
        </>}
        actions={<>
          {o.status === "draft" && ctx.can("sales_order:update") ? <Link href={`/orders/${o.id}/edit`} className={buttonVariants({ variant: "outline" })}><Pencil /> Edit draft</Link> : null}
          {canDispatch && hasOutstandingToDispatch ? <Link href={`/orders/${o.id}/dispatch`} className={buttonVariants()}><Truck /> Create dispatch</Link> : null}
          <OrderActions orderId={o.id} orderNumber={o.orderNumber} status={o.status} canConfirm={ctx.can("sales_order:confirm")} canCancel={ctx.can("sales_order:update")} />
        </>}
      />

      {o.status === "draft" ? <Notice tone="info" className="mb-4">This order is a draft. Confirm it to allow work to be released into production.</Notice> : null}
      {o.status === "confirmed" && unreleased > 0 ? <Notice tone="info" className="mb-4">{unreleased} line{unreleased === 1 ? " has" : "s have"} not been released to production yet.{canRelease ? "" : " Releasing work needs permission to create production jobs."}</Notice> : null}
      {(o.status === "confirmed" || o.status === "in_production" || o.status === "partially_delivered") && !hasOutstandingToDispatch ? <Notice tone="info" className="mb-4">Everything on this order has been dispatched.</Notice> : null}
      {o.status === "cancelled" ? <Notice tone="warning" className="mb-4">This order was cancelled. The reason is recorded in the audit log.</Notice> : null}

      <Card className="mb-5">
        <Table>
          <THead>
            <tr><TH>Product</TH><TH className="text-right">Quantity</TH><TH className="text-right">Unit price</TH><TH className="text-right">Line total</TH><TH className="text-right">Dispatched</TH><TH className="text-right">Remaining</TH>{showJobs ? <TH>Production</TH> : null}</tr>
          </THead>
          <TBody>
            {o.lines.map((l) => (
              <TR key={l.id}>
                <TD><span className="font-medium">{l.itemName}</span><span className="block text-xs text-muted-foreground">{l.sku}</span></TD>
                <TD className="text-right"><Quantity value={l.quantity} uom={l.uom} /></TD>
                <TD className="text-right"><Money amount={l.unitPrice} currency={l.currency} /></TD>
                <TD className="text-right"><Money amount={l.lineTotal} currency={l.currency} /></TD>
                <TD className="text-right"><Quantity value={l.dispatchedQty} uom={l.uom} /></TD>
                <TD className="text-right"><Quantity value={l.remainingToDispatchQty} uom={l.uom} /></TD>
                {showJobs ? (
                  <TD>
                    {l.productionJob ? (
                      <span className="flex items-center gap-2"><Link href={`/production/jobs/${l.productionJob.id}`} className="font-medium text-primary hover:underline">{l.productionJob.jobNumber}</Link><JobStatusBadge status={l.productionJob.status} /></span>
                    ) : canRelease ? (
                      <ReleaseLineButton line={{ id: l.id, itemId: l.itemId, quantity: l.quantity, sku: l.sku }} branchId={o.branchId} />
                    ) : <span className="text-muted-foreground">{o.status === "draft" ? "Confirm the order first" : "Not released"}</span>}
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
        <p className="border-t border-border px-4 py-3 text-right text-sm">Order total (no tax or discounts): <strong><Money amount={o.total} currency={o.currency} /></strong></p>
      </Card>

      {dispatches ? (
        <section aria-labelledby="dispatches-h">
          <h2 id="dispatches-h" className="mb-2 text-sm font-semibold">Dispatches</h2>
          {!dispatches.ok ? (
            <ErrorState title="Dispatches couldn't be loaded" message={dispatches.message} />
          ) : dispatches.data.length === 0 ? (
            <Card className="p-4 text-sm text-muted-foreground">Nothing has been dispatched against this order yet.</Card>
          ) : (
            <div className="space-y-3">
              {dispatches.data.map((d) => (
                <Card key={d.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <Link href={`/dispatches/${d.id}`} className="font-medium text-primary hover:underline">{d.dispatchNumber}</Link>
                      <DispatchStatusBadge status={d.status} />
                      <span className="text-muted-foreground">— dispatched {formatDateTimeLocal(d.dispatchedAt)}</span>
                    </span>
                  </div>
                  <Table>
                    <THead><tr><TH>Item</TH><TH className="text-right">Quantity</TH><TH>Batches</TH></tr></THead>
                    <TBody>
                      {d.lines.map((l) => (
                        <TR key={l.id}>
                          <TD><span className="font-medium">{l.itemName}</span><span className="block text-xs text-muted-foreground">{l.sku}</span></TD>
                          <TD className="text-right"><Quantity value={l.quantity} uom={l.uom} /></TD>
                          <TD className="text-xs text-muted-foreground">{l.batchAllocations.map((a) => a.batchNumber).join(", ")}</TD>
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
