import Link from "next/link";

import { listFinishedGoodsBatches } from "../../../../src/server/modules/inventory/finished-goods-service";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { FgBatchStatusBadge } from "../../../../components/ui/status-badge";
import { PageHeader } from "../../../../components/ui/page-header";
import { Select } from "../../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { Quantity } from "../../../../components/ui/provenance";
import { formatDate } from "../../../../lib/format";
import { getPageContext, load, param, UUID_RE } from "../../../../lib/server/page-context";
import { itemLabel, loadItems, loadWarehouses } from "../../../../lib/server/lookups";
import type { FinishedGoodsBatchDetail } from "../../../../lib/api-types";

export const metadata = { title: "Finished goods · Operis" };

export default async function FinishedGoodsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("finished_goods:read")) return <AccessDenied what="finished-goods inventory" />;

  const sp = await searchParams;
  const uuid = (v: string | undefined) => (v && UUID_RE.test(v) ? v : undefined);
  const productItemId = uuid(param(sp.productItemId));
  const warehouseId = uuid(param(sp.warehouseId));
  const status = param(sp.status);
  const search = param(sp.search);

  const [batches, items, warehouses] = await Promise.all([
    load<FinishedGoodsBatchDetail[]>(() => listFinishedGoodsBatches(ctx.session, { productItemId, warehouseId, status, search, limit: 300 })),
    loadItems(ctx),
    loadWarehouses(ctx),
  ]);
  const branchId = ctx.selectedBranchId;
  const selectableWarehouses = warehouses.list.filter((w) => !branchId || w.branchId === branchId);

  return (
    <>
      <PageHeader
        title="Finished goods"
        crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Finished goods" }]}
        description="Valued, traceable finished-goods batches received from production. Open a batch to see its full cost and lot lineage, or to transfer, adjust or re-disposition it."
      />

      <FilterBar resetHref="/inventory/finished-goods">
        <FilterField id="productItemId" label="Product" className="min-w-52 flex-1">
          <Select id="productItemId" name="productItemId" defaultValue={productItemId ?? ""}>
            <option value="">All products</option>
            {items.list.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.sku})
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField id="warehouseId" label="Warehouse">
          <Select id="warehouseId" name="warehouseId" defaultValue={warehouseId ?? ""}>
            <option value="">All warehouses</option>
            {selectableWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="quarantined">Quarantined</option>
            <option value="rejected">Rejected</option>
          </Select>
        </FilterField>
        <FilterField id="search" label="Batch number">
          <Input id="search" name="search" defaultValue={search ?? ""} placeholder="FG-000123" />
        </FilterField>
      </FilterBar>

      {!batches.ok ? (
        <LoadFailure status={batches.status} message={batches.message} what="finished-goods batches" />
      ) : batches.data.length === 0 ? (
        <EmptyState title="No batch matches">Try clearing the filters, or receive a completed job&apos;s output into finished goods from its Finished Goods tab.</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Batch</TH>
                <TH>Product</TH>
                <TH>Job</TH>
                <TH>Warehouse</TH>
                <TH>Status</TH>
                <TH className="text-right">Received</TH>
                <TH className="text-right">Remaining</TH>
                <TH>Produced</TH>
              </tr>
            </THead>
            <TBody>
              {batches.data.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <Link href={`/inventory/finished-goods/${b.id}`} className="font-medium text-primary hover:underline">
                      {b.batchNumber}
                    </Link>
                    {b.transferredFromBatchId ? <span className="block text-xs text-muted-foreground">Transferred batch</span> : null}
                  </TD>
                  <TD>{itemLabel({ name: b.productName, sku: b.productSku }, b.productItemId)}</TD>
                  <TD>
                    {ctx.can("production_job:read") ? (
                      <Link href={`/production/jobs/${b.jobId}`} className="text-primary hover:underline">
                        {b.jobNumber}
                      </Link>
                    ) : (
                      b.jobNumber
                    )}
                  </TD>
                  <TD>{warehouses.byId.get(b.warehouseId)?.name ?? "Warehouse"}</TD>
                  <TD>
                    <FgBatchStatusBadge status={b.status} />
                  </TD>
                  <TD className="text-right">
                    <Quantity value={b.goodQty} uom={b.uom} />
                  </TD>
                  <TD className={`text-right font-medium ${Number(b.remaining) <= 0 ? "text-muted-foreground" : ""}`}>
                    <Quantity value={b.remaining} uom={b.uom} />
                  </TD>
                  <TD>{formatDate(b.producedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing the latest {batches.data.length} batch{batches.data.length === 1 ? "" : "es"}.</p>
        </Card>
      )}
    </>
  );
}
