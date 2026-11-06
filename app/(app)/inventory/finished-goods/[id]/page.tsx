import Link from "next/link";
import { notFound } from "next/navigation";

import { getBatchDetail, getBatchTraceability } from "../../../../../src/server/modules/inventory/finished-goods-service";
import { FgBatchStatusActions } from "../../../../../components/features/inventory/fg-batch-status-actions";
import { FgBatchTransferActions } from "../../../../../components/features/inventory/fg-batch-transfer-actions";
import { FgBatchAdjustActions } from "../../../../../components/features/inventory/fg-batch-adjust-actions";
import { Card } from "../../../../../components/ui/card";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../../components/ui/provenance";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { FgBatchStatusBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { formatDate, formatDateTimeUtc, formatQuantity, formatSignedQuantity } from "../../../../../lib/format";
import { getPageContext, load, UUID_RE } from "../../../../../lib/server/page-context";
import { itemLabel, loadItems, loadWarehouses } from "../../../../../lib/server/lookups";
import type { FinishedGoodsBatchFull, FgBatchTraceability } from "../../../../../lib/api-types";

export const metadata = { title: "Finished-goods batch · Operis" };

export default async function FinishedGoodsBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("finished_goods:read")) return <AccessDenied what="finished-goods inventory" />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const [detail, traceability, items, warehouses] = await Promise.all([
    load<FinishedGoodsBatchFull>(() => getBatchDetail(ctx.session, id)),
    load<FgBatchTraceability>(() => getBatchTraceability(ctx.session, id)),
    loadItems(ctx),
    loadWarehouses(ctx),
  ]);
  if (!detail.ok) {
    if (detail.status === 404) notFound();
    return <LoadFailure status={detail.status} message={detail.message} what="this finished-goods batch" />;
  }
  const b = detail.data;
  const showCost = ctx.can("cost:read");
  const canManage = ctx.can("finished_goods:manage");
  const activeDestinations = warehouses.list.filter((w) => w.isActive && w.id !== b.warehouseId);

  return (
    <>
      <PageHeader
        title={
          <>
            {b.batchNumber} <FgBatchStatusBadge status={b.status} />
          </>
        }
        crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Finished goods", href: "/inventory/finished-goods" }, { label: b.batchNumber }]}
        meta={
          <>
            <span>Product: {itemLabel({ name: b.productName, sku: b.productSku }, b.productItemId)}</span>
            <span>Warehouse: {warehouses.byId.get(b.warehouseId)?.name ?? "Warehouse"}</span>
            <span>Produced: {formatDate(b.producedAt)}</span>
            {ctx.can("production_job:read") ? (
              <span>
                Job:{" "}
                <Link href={`/production/jobs/${b.jobId}`} className="text-primary hover:underline">
                  {b.jobNumber}
                </Link>
              </span>
            ) : (
              <span>Job: {b.jobNumber}</span>
            )}
          </>
        }
        actions={
          canManage ? (
            <>
              <FgBatchStatusActions batchId={b.id} batchNumber={b.batchNumber} status={b.status} />
              <FgBatchTransferActions batchId={b.id} batchNumber={b.batchNumber} remaining={b.remaining} uom={b.uom} currentWarehouseId={b.warehouseId} warehouses={activeDestinations} />
              <FgBatchAdjustActions batchId={b.id} batchNumber={b.batchNumber} remaining={b.remaining} uom={b.uom} />
            </>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Received</p>
          <p className="text-lg font-semibold tabular-nums">
            <Quantity value={b.goodQty} uom={b.uom} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Remaining</p>
          <p className="text-lg font-semibold tabular-nums">
            <Quantity value={b.remaining} uom={b.uom} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Lineage</p>
          <p className="text-lg font-semibold">{b.transferredFromBatchId ? "Transferred batch" : "Original receipt"}</p>
        </Card>
      </div>

      {b.qualityNotes ? (
        <Card className="mt-4 p-4">
          <h2 className="mb-1 text-sm font-semibold">Quality notes</h2>
          <p className="text-sm text-muted-foreground">{b.qualityNotes}</p>
        </Card>
      ) : null}

      {showCost ? (
        <Card className="mt-4 p-4">
          <h2 className="mb-1 text-sm font-semibold">Cost (operational valuation, not a general-ledger figure)</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Values this batch&apos;s originally received quantity ({formatQuantity(b.goodQty, b.uom)}), not just what remains ({formatQuantity(b.remaining, b.uom)}) -- the cost basis of a unit doesn&apos;t change as units
            are transferred or adjusted out.
          </p>
          {!b.costLines || b.costLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No cost recorded for this batch.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Currency</TH>
                  <TH className="text-right">Material cost</TH>
                  <TH className="text-right">Labour cost</TH>
                  <TH className="text-right">Total</TH>
                </tr>
              </THead>
              <TBody>
                {b.costLines.map((c) => (
                  <TR key={c.currency}>
                    <TD>{c.currency}</TD>
                    <TD className="text-right">
                      <Money amount={c.materialCost} currency={c.currency} />
                    </TD>
                    <TD className="text-right">
                      <Money amount={c.labourCost} currency={c.currency} unavailableReason="no labour recorded" />
                    </TD>
                    <TD className="text-right font-medium">
                      <Money amount={String(Number(c.materialCost) + Number(c.labourCost ?? 0))} currency={c.currency} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {b.transferredFromBatchId ? <Notice tone="neutral" className="mt-3">This batch was transferred from another warehouse. Its cost is resolved live from the original receipt, scaled to this batch&apos;s own quantity -- it is never a separate, duplicated total.</Notice> : null}
        </Card>
      ) : null}

      <Card className="mt-4 p-4">
        <h2 className="mb-2 text-sm font-semibold">Material lot lineage</h2>
        {!traceability.ok ? (
          <LoadFailure status={traceability.status} message={traceability.message} what="this batch's traceability" />
        ) : traceability.data.materialLots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No lot-tracked material could be attributed to this batch.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Lot</TH>
                <TH>Material</TH>
                <TH className="text-right">Attributed quantity</TH>
              </tr>
            </THead>
            <TBody>
              {traceability.data.materialLots.map((l, i) => (
                <TR key={`${l.lotId}-${i}`}>
                  <TD>
                    {ctx.can("lot:read") ? (
                      <Link href={`/inventory/lots/${l.lotId}`} className="text-primary hover:underline">
                        {l.lotNumber}
                      </Link>
                    ) : (
                      l.lotNumber
                    )}
                  </TD>
                  <TD>{itemLabel(items.byId.get(l.materialItemId), l.materialItemId)}</TD>
                  <TD className="text-right">
                    <Quantity value={l.quantity} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        {traceability.ok ? (
          <>
            <Notice tone="neutral" className="mt-3">
              {traceability.data.genealogyNote}
            </Notice>
            <Notice tone="neutral" className="mt-2">
              {traceability.data.forwardChainNote}
            </Notice>
          </>
        ) : null}
      </Card>

      <Card className="mt-4 p-4">
        <h2 className="mb-2 text-sm font-semibold">Movements against this batch</h2>
        {b.movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transfers or adjustments have been posted against this batch yet.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Type</TH>
                <TH className="text-right">Quantity</TH>
                <TH>Reason</TH>
                <TH>When</TH>
              </tr>
            </THead>
            <TBody>
              {b.movements.map((m) => (
                <TR key={m.id}>
                  <TD className="capitalize">{m.type.replace("_", " ")}</TD>
                  <TD className="text-right tabular-nums">{formatSignedQuantity(m.quantity)}</TD>
                  <TD>{m.reason ?? <span className="text-muted-foreground">—</span>}</TD>
                  <TD>{formatDateTimeUtc(m.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
