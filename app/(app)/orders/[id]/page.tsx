import Link from "next/link";
import { Pencil } from "lucide-react";

import { OrderActions, ReleaseLineButton } from "../../../../components/features/orders/order-actions";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../components/ui/provenance";
import { AccessDenied, LoadFailure } from "../../../../components/ui/states";
import { JobStatusBadge, OrderStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { getSalesOrder } from "../../../../src/server/modules/sales/sales-order-service";
import { formatDate, formatDateTimeLocal } from "../../../../lib/format";
import { getPageContext, load } from "../../../../lib/server/page-context";

export const metadata = { title: "Sales order · Operis" };

interface Order {
  id: string; orderNumber: string; branchId: string; status: string; currency: string; total: string; requestedDeliveryDate: string | null; createdAt: string; updatedAt: string;
  customer: { id: string; name: string };
  lines: { id: string; itemId: string; sku: string; itemName: string; uom: string; quantity: string; unitPrice: string; lineTotal: string; currency: string; productionJob?: { id: string; jobNumber: string; status: string } | null }[];
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
          <OrderActions orderId={o.id} orderNumber={o.orderNumber} status={o.status} canConfirm={ctx.can("sales_order:confirm")} canCancel={ctx.can("sales_order:update")} />
        </>}
      />

      {o.status === "draft" ? <Notice tone="info" className="mb-4">This order is a draft. Confirm it to allow work to be released into production.</Notice> : null}
      {o.status === "confirmed" && unreleased > 0 ? <Notice tone="info" className="mb-4">{unreleased} line{unreleased === 1 ? " has" : "s have"} not been released to production yet.{canRelease ? "" : " Releasing work needs permission to create production jobs."}</Notice> : null}
      {o.status === "cancelled" ? <Notice tone="warning" className="mb-4">This order was cancelled. The reason is recorded in the audit log.</Notice> : null}

      <Card>
        <Table>
          <THead>
            <tr><TH>Product</TH><TH className="text-right">Quantity</TH><TH className="text-right">Unit price</TH><TH className="text-right">Line total</TH>{showJobs ? <TH>Production</TH> : null}</tr>
          </THead>
          <TBody>
            {o.lines.map((l) => (
              <TR key={l.id}>
                <TD><span className="font-medium">{l.itemName}</span><span className="block text-xs text-muted-foreground">{l.sku}</span></TD>
                <TD className="text-right"><Quantity value={l.quantity} uom={l.uom} /></TD>
                <TD className="text-right"><Money amount={l.unitPrice} currency={l.currency} /></TD>
                <TD className="text-right"><Money amount={l.lineTotal} currency={l.currency} /></TD>
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
    </>
  );
}
