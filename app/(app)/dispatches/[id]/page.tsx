import Link from "next/link";
import { notFound } from "next/navigation";

import { getDispatch } from "../../../../src/server/modules/inventory/dispatch-service";
import { ConfirmDeliveryAction } from "../../../../components/features/sales/dispatch-actions";
import { Card } from "../../../../components/ui/card";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../components/ui/provenance";
import { AccessDenied, LoadFailure } from "../../../../components/ui/states";
import { DispatchStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { formatDateTimeLocal } from "../../../../lib/format";
import { getPageContext, load, UUID_RE } from "../../../../lib/server/page-context";
import type { Dispatch } from "../../../../lib/api-types";

export const metadata = { title: "Dispatch · Operis" };

export default async function DispatchPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("dispatch:read")) return <AccessDenied what="dispatches" />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const res = await load<Dispatch>(() => getDispatch(ctx.session, id));
  if (!res.ok) {
    if (res.status === 404) notFound();
    return <LoadFailure status={res.status} message={res.message} what="this dispatch" />;
  }
  const d = res.data;
  const canConfirm = d.status === "dispatched" && ctx.can("dispatch:create");
  const canSeeOrder = ctx.can("sales_order:read");
  const canSeeCost = ctx.can("cost:read");

  return (
    <>
      <PageHeader
        title={
          <>
            {d.dispatchNumber} <DispatchStatusBadge status={d.status} />
          </>
        }
        crumbs={[{ label: "Orders", href: "/orders" }, { label: "Dispatches", href: "/dispatches" }, { label: d.dispatchNumber }]}
        meta={
          <>
            <span>
              Order:{" "}
              {canSeeOrder ? (
                <Link href={`/orders/${d.salesOrderId}`} className="text-primary hover:underline">
                  {d.orderNumber}
                </Link>
              ) : (
                d.orderNumber
              )}
            </span>
            <span>Customer: {d.customer.name}</span>
            <span>Warehouse: {d.warehouseName}</span>
            <span>Dispatched: {formatDateTimeLocal(d.dispatchedAt)}</span>
            {d.carrier ? <span>Carrier: {d.carrier}</span> : null}
            {d.trackingReference ? <span>Tracking: {d.trackingReference}</span> : null}
          </>
        }
        actions={canConfirm ? <ConfirmDeliveryAction dispatchId={d.id} dispatchNumber={d.dispatchNumber} /> : null}
      />

      {d.notes ? <Notice tone="info" className="mb-4">{d.notes}</Notice> : null}

      {d.status === "delivered" ? (
        <Notice tone="success" className="mb-4">
          Delivery confirmed {d.deliveredAt ? formatDateTimeLocal(d.deliveredAt) : ""}
          {d.receivedBy ? ` — received by ${d.receivedBy}` : ""}
          {d.deliveryNotes ? `. ${d.deliveryNotes}` : ""}
        </Notice>
      ) : null}

      <Card className="mb-5">
        <Table>
          <THead>
            <tr>
              <TH>Item</TH>
              <TH className="text-right">Quantity</TH>
              <TH>Batch allocations</TH>
            </tr>
          </THead>
          <TBody>
            {d.lines.map((l) => (
              <TR key={l.id}>
                <TD>
                  <span className="font-medium">{l.itemName}</span>
                  <span className="block text-xs text-muted-foreground">{l.sku}</span>
                </TD>
                <TD className="text-right">
                  <Quantity value={l.quantity} uom={l.uom} />
                </TD>
                <TD>
                  <ul className="space-y-0.5">
                    {l.batchAllocations.map((a) => (
                      <li key={a.batchId} className="text-xs">
                        {ctx.can("finished_goods:read") ? (
                          <Link href={`/inventory/finished-goods/${a.batchId}`} className="text-primary hover:underline">
                            {a.batchNumber}
                          </Link>
                        ) : (
                          a.batchNumber
                        )}
                        <span className="text-muted-foreground"> — {a.quantity} {l.uom}</span>
                      </li>
                    ))}
                  </ul>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      {canSeeCost ? (
        <Card className="p-4">
          <h2 className="mb-1 text-sm font-semibold">Cost of goods dispatched</h2>
          <p className="mb-2 text-xs text-muted-foreground">{d.costNote ?? "Informational valuation, not a general-ledger posting."}</p>
          {!d.costOfGoodsDispatched || d.costOfGoodsDispatched.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cost could be resolved for the batches in this dispatch.</p>
          ) : (
            <ul className="space-y-1">
              {d.costOfGoodsDispatched.map((c) => (
                <li key={c.currency} className="text-sm">
                  <Money amount={c.amount} currency={c.currency} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </>
  );
}
