import Link from "next/link";

import { getLotDetail, getLotTraceability } from "../../../../../src/server/modules/inventory/lot-service";
import { LotStatusActions } from "../../../../../components/features/inventory/lot-status-actions";
import { Card } from "../../../../../components/ui/card";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { LotStatusBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { formatDate, formatQuantity } from "../../../../../lib/format";
import { getPageContext, load } from "../../../../../lib/server/page-context";
import { itemLabel, loadItems, loadWarehouses } from "../../../../../lib/server/lookups";
import type { LotDetail, LotTraceability } from "../../../../../lib/api-types";

export const metadata = { title: "Material lot · Operis" };

export default async function LotDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("lot:read")) return <AccessDenied what="material lots" />;
  const { id } = await params;

  const [detail, traceability, items, warehouses] = await Promise.all([
    load<LotDetail>(() => getLotDetail(ctx.session, id)),
    load<LotTraceability>(() => getLotTraceability(ctx.session, id)),
    loadItems(ctx),
    loadWarehouses(ctx),
  ]);
  if (!detail.ok) return <LoadFailure status={detail.status} message={detail.message} what="this material lot" />;
  const l = detail.data;
  const it = items.byId.get(l.itemId);

  return (
    <>
      <PageHeader
        title={<>{l.lotNumber} <LotStatusBadge status={l.status} /></>}
        crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Material lots", href: "/inventory/lots" }, { label: l.lotNumber }]}
        meta={<>
          <span>Item: {itemLabel(it, l.itemId)}</span>
          <span>Warehouse: {warehouses.byId.get(l.warehouseId)?.name ?? "Warehouse"}</span>
          <span>Received: {formatDate(l.receivedAt)}</span>
          {l.expiryDate ? <span>Expires: {formatDate(l.expiryDate)}</span> : null}
          {l.supplierLotRef ? <span>Supplier ref: {l.supplierLotRef}</span> : null}
        </>}
        actions={ctx.can("lot:manage") ? <LotStatusActions lotId={l.id} lotNumber={l.lotNumber} status={l.status} /> : null}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Received</p>
          <p className="text-lg font-semibold tabular-nums">{formatQuantity(l.quantityReceived, l.uom)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Remaining</p>
          <p className="text-lg font-semibold tabular-nums">{formatQuantity(l.remaining, l.uom)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Available for consumption</p>
          <p className="text-lg font-semibold">{l.available ? "Yes" : "No"}</p>
        </Card>
      </div>

      <Card className="mt-4 p-4">
        <h2 className="mb-2 text-sm font-semibold">Origin</h2>
        {l.origin.type === "receipt" ? (
          <p className="text-sm">
            Received against purchase order{" "}
            {ctx.can("purchase_order:read") ? (
              <Link href={`/purchasing/orders/${l.origin.purchaseOrderId}`} className="text-primary hover:underline">{l.origin.purchaseOrderNumber}</Link>
            ) : (
              l.origin.purchaseOrderNumber
            )}{" "}
            from {l.origin.supplierName}.
          </p>
        ) : (
          <p className="text-sm">
            Spawned by a material return{l.origin.sourceReturnJobNumber ? <> from job {l.origin.sourceReturnJobNumber}</> : null}
            {l.origin.sourceReturnOfLotNumber ? (
              <>
                {" "}that needed inspection, out of{" "}
                <Link href={`/inventory/lots/${l.origin.sourceReturnOfLotId}`} className="text-primary hover:underline">{l.origin.sourceReturnOfLotNumber}</Link>.
              </>
            ) : (
              "."
            )}
          </p>
        )}
      </Card>

      {l.returnChildLots.length > 0 ? (
        <Card className="mt-4 p-4">
          <h2 className="mb-2 text-sm font-semibold">Lots spawned from a return of this lot</h2>
          <ul className="space-y-1 text-sm">
            {l.returnChildLots.map((c) => (
              <li key={c.id}>
                <Link href={`/inventory/lots/${c.id}`} className="text-primary hover:underline">{c.lotNumber}</Link>{" "}
                <LotStatusBadge status={c.status} /> — {formatQuantity(c.quantityReceived, l.uom)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mt-4 p-4">
        <h2 className="mb-2 text-sm font-semibold">Consumed by jobs</h2>
        {!traceability.ok ? (
          <LoadFailure status={traceability.status} message={traceability.message} what="this lot's traceability" />
        ) : traceability.data.consumedByJobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been issued from this lot yet.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Job</TH>
                <TH className="text-right">Consumed</TH>
                <TH className="text-right">Returned</TH>
                <TH className="text-right">Net outstanding</TH>
              </tr>
            </THead>
            <TBody>
              {traceability.data.consumedByJobs.map((j) => (
                <TR key={j.jobId}>
                  <TD>
                    {ctx.can("production_job:read") ? (
                      <Link href={`/production/jobs/${j.jobId}?tab=materials`} className="text-primary hover:underline">{j.jobNumber}</Link>
                    ) : (
                      j.jobNumber
                    )}
                  </TD>
                  <TD className="text-right tabular-nums">{formatQuantity(j.consumed, l.uom)}</TD>
                  <TD className="text-right tabular-nums">{formatQuantity(j.returned, l.uom)}</TD>
                  <TD className="text-right font-medium tabular-nums">{formatQuantity(j.netOutstanding, l.uom)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {traceability.ok ? <Notice tone="neutral" className="mt-3">{traceability.data.forwardChainNote}</Notice> : null}
      </Card>
    </>
  );
}
