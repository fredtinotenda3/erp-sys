import Link from "next/link";

import { listStockMovements } from "../../../../src/server/modules/inventory/stock-service";
import { listJobs } from "../../../../src/server/modules/production/job-service";
import { Card } from "../../../../components/ui/card";
import { LocalTime } from "../../../../components/ui/local-time";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money } from "../../../../components/ui/provenance";
import { Select } from "../../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { formatSignedQuantity } from "../../../../lib/format";
import { MOVEMENT_LABELS } from "../../../../lib/labels";
import { getPageContext, load, param, UUID_RE } from "../../../../lib/server/page-context";
import { itemLabel, loadItems, loadUsers, loadWarehouses } from "../../../../lib/server/lookups";
import type { Job, StockMovement } from "../../../../lib/api-types";

export const metadata = { title: "Stock movements · Operis" };

export default async function MovementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("stock:read")) return <AccessDenied what="stock movements" />;

  const sp = await searchParams;
  const uuid = (v: string | undefined) => (v && UUID_RE.test(v) ? v : undefined);
  const itemId = uuid(param(sp.itemId));
  const warehouseId = uuid(param(sp.warehouseId));
  const referenceId = uuid(param(sp.referenceId));
  const limit = param(sp.limit) === "500" ? 500 : 200;
  const showCost = ctx.can("cost:read");

  const [moves, items, warehouses, users, jobs] = await Promise.all([
    load<StockMovement[]>(() => listStockMovements(ctx.session, { itemId, warehouseId, referenceId, limit })),
    loadItems(ctx),
    loadWarehouses(ctx),
    loadUsers(ctx),
    ctx.can("production_job:read") ? load<Job[]>(() => listJobs(ctx.session, { limit: 500 })) : Promise.resolve(null),
  ]);
  const jobNumber = new Map((jobs?.ok ? jobs.data : []).map((j) => [j.id, j.jobNumber]));
  const actor = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "System");
  const branchId = ctx.selectedBranchId;
  const selectableWarehouses = warehouses.list.filter((w) => !branchId || w.branchId === branchId);
  const rows = moves.ok ? moves.data.filter((m) => !branchId || m.branchId === branchId) : [];

  return (
    <>
      <PageHeader title="Stock movements" description="Every change to stock, newest first. This ledger is append-only: corrections are new entries, never edits." />

      {referenceId ? (
        <Notice tone="info" className="mb-3">
          Filtered to one production job. <Link className="underline" href="/inventory/movements">Show all movements</Link>
        </Notice>
      ) : null}

      <FilterBar resetHref="/inventory/movements">
        <FilterField id="itemId" label="Item" className="min-w-52 flex-1">
          <Select id="itemId" name="itemId" defaultValue={itemId ?? ""}>
            <option value="">All items</option>
            {items.list.map((i) => (
              <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>
            ))}
          </Select>
        </FilterField>
        <FilterField id="warehouseId" label="Warehouse">
          <Select id="warehouseId" name="warehouseId" defaultValue={warehouseId ?? ""}>
            <option value="">All warehouses</option>
            {selectableWarehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
        </FilterField>
        {referenceId ? <input type="hidden" name="referenceId" value={referenceId} /> : null}
      </FilterBar>

      {!moves.ok ? (
        <LoadFailure status={moves.status} message={moves.message} what="stock movements" />
      ) : rows.length === 0 ? (
        <EmptyState title="No movements match">Try clearing the filters.</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>When</TH>
                <TH>Type</TH>
                <TH>Item</TH>
                <TH>Warehouse</TH>
                <TH className="text-right">Quantity</TH>
                {showCost ? <TH className="text-right">Unit cost</TH> : null}
                <TH>Reference</TH>
                <TH>By</TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((m) => {
                const it = items.byId.get(m.itemId);
                const negative = m.quantity.startsWith("-");
                return (
                  <TR key={m.id}>
                    <TD><LocalTime iso={m.occurredAt} /></TD>
                    <TD>{MOVEMENT_LABELS[m.movementType] ?? m.movementType}</TD>
                    <TD>{itemLabel(it, m.itemId)}</TD>
                    <TD>{warehouses.byId.get(m.warehouseId)?.name ?? "Warehouse"}</TD>
                    <TD className={`text-right font-medium tabular-nums ${negative ? "text-status-danger" : "text-status-success"}`}>
                      {formatSignedQuantity(m.quantity)} <span className="font-normal text-muted-foreground">{it?.uom}</span>
                    </TD>
                    {showCost ? <TD className="text-right">{m.unitCost ? <Money amount={m.unitCost} currency={m.currency} /> : <span className="text-muted-foreground">—</span>}</TD> : null}
                    <TD>
                      {m.referenceType === "production_job" && m.referenceId ? (
                        <Link href={`/production/jobs/${m.referenceId}?tab=materials`} className="text-primary hover:underline">
                          {jobNumber.get(m.referenceId) ?? `Job ${m.referenceId.slice(0, 8)}`}
                        </Link>
                      ) : null}
                      {m.reason ? <span className="block max-w-64 whitespace-normal text-xs text-muted-foreground">{m.reason}</span> : null}
                      {!m.reason && !(m.referenceType === "production_job" && m.referenceId) ? <span className="text-muted-foreground">—</span> : null}
                    </TD>
                    <TD>{actor(m.createdById)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            Showing the latest {rows.length} movement{rows.length === 1 ? "" : "s"}.{" "}
            {moves.data.length >= limit && limit < 500 ? (
              <Link className="text-primary underline" href={`/inventory/movements?${new URLSearchParams({ ...(itemId ? { itemId } : {}), ...(warehouseId ? { warehouseId } : {}), ...(referenceId ? { referenceId } : {}), limit: "500" })}`}>
                Show up to 500
              </Link>
            ) : null}
          </p>
        </Card>
      )}
    </>
  );
}
