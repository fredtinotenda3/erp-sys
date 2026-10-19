import Link from "next/link";

import { listStockBalances } from "../../../../src/server/modules/inventory/stock-service";
import { getShortages } from "../../../../src/server/modules/inventory/shortage-service";
import { buttonVariants } from "../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../components/ui/provenance";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { StockStatusBadge } from "../../../../components/ui/status-badge";
import { Select } from "../../../../components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { getPageContext, load, param, UUID_RE } from "../../../../lib/server/page-context";
import { itemLabel, loadItems, loadWarehouses } from "../../../../lib/server/lookups";
import type { Shortage, StockBalance } from "../../../../lib/api-types";

export const metadata = { title: "Stock · Operis" };

export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("stock:read")) return <AccessDenied what="stock levels" />;

  const sp = await searchParams;
  const q = param(sp.q)?.toLowerCase();
  const whParam = param(sp.warehouseId);
  const warehouseId = whParam && UUID_RE.test(whParam) ? whParam : undefined;
  const showCost = ctx.can("cost:read");
  const branchId = ctx.selectedBranchId ?? undefined;

  const [warehouses, items, balances, shortages] = await Promise.all([
    loadWarehouses(ctx),
    loadItems(ctx),
    load<StockBalance[]>(() => listStockBalances(ctx.session, { warehouseId })),
    ctx.can("production_job:read") ? load<Shortage[]>(() => getShortages(ctx.session, { branchId })) : Promise.resolve(null),
  ]);

  const inBranch = new Set(warehouses.list.filter((w) => !branchId || w.branchId === branchId).map((w) => w.id));
  const selectableWarehouses = warehouses.list.filter((w) => !branchId || w.branchId === branchId);
  const whName = (id: string) => warehouses.byId.get(id)?.name ?? "Warehouse";

  const rows = balances.ok
    ? balances.data.filter((b) => (!branchId || inBranch.has(b.warehouseId)) && (!q || itemLabel(items.byId.get(b.itemId), b.itemId).toLowerCase().includes(q)))
    : [];
  const attention = shortages?.ok ? shortages.data.filter((s) => s.status !== "ok") : [];

  return (
    <>
      <PageHeader
        title="Stock"
        description={ctx.selectedBranchId ? `Balances in ${ctx.branchName(ctx.selectedBranchId)}.` : "Balances across the warehouses you can access."}
        actions={
          <>
            {ctx.can("stock:receive") ? <Link href="/inventory/receive" className={buttonVariants()}>Receive stock</Link> : null}
            {ctx.can("material:issue") ? <Link href="/inventory/issue" className={buttonVariants({ variant: "outline" })}>Issue to job</Link> : null}
            {ctx.can("stock:adjust") ? <Link href="/inventory/adjust" className={buttonVariants({ variant: "outline" })}>Adjust</Link> : null}
          </>
        }
      />

      {shortages ? (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>Shortages and low stock</CardTitle>
            <span className="text-xs text-muted-foreground">Per branch, across its warehouses</span>
          </CardHeader>
          {!shortages.ok ? (
            <CardContent>
              <LoadFailure status={shortages.status} message={shortages.message} what="shortages" />
            </CardContent>
          ) : attention.length === 0 ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">No open job is short of material and nothing is below its reorder level.</p>
            </CardContent>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Material</TH>
                  <TH>Status</TH>
                  <TH className="text-right">On hand</TH>
                  <TH className="text-right">Needed by open jobs</TH>
                  <TH className="text-right">Short by</TH>
                  <TH>Jobs</TH>
                </tr>
              </THead>
              <TBody>
                {attention.map((s) => (
                  <TR key={`${s.branchId}-${s.item.id}`}>
                    <TD>
                      <Link href={`/catalog/items/${s.item.id}`} className="font-medium text-primary hover:underline">
                        {s.item.name ?? itemLabel(items.byId.get(s.item.id), s.item.id)}
                      </Link>
                      {!s.hasStockRecord ? <span className="block text-xs text-muted-foreground">No stock recorded</span> : null}
                      {ctx.me.branches.length > 1 && !branchId ? <span className="block text-xs text-muted-foreground">{ctx.branchName(s.branchId)}</span> : null}
                    </TD>
                    <TD>
                      <StockStatusBadge status={s.status} />
                    </TD>
                    <TD className="text-right"><Quantity value={s.onHand} uom={s.item.uom} /></TD>
                    <TD className="text-right"><Quantity value={s.remainingRequirement} uom={s.item.uom} /></TD>
                    <TD className="text-right">{s.shortageQty && Number(s.shortageQty) > 0 ? <span className="font-medium text-status-danger"><Quantity value={s.shortageQty} uom={s.item.uom} /></span> : <span className="text-muted-foreground">—</span>}</TD>
                    <TD>
                      {s.demand.slice(0, 3).map((d, i) => (
                        <span key={d.jobId}>
                          {i > 0 ? ", " : ""}
                          <Link href={`/production/jobs/${d.jobId}?tab=materials`} className="text-primary hover:underline">{d.jobNumber}</Link>
                        </span>
                      ))}
                      {s.demand.length > 3 ? <span className="text-muted-foreground"> +{s.demand.length - 3}</span> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      ) : null}

      <FilterBar resetHref="/inventory/stock">
        <FilterField id="q" label="Search item" className="min-w-52 flex-1">
          <Input id="q" name="q" type="search" defaultValue={param(sp.q) ?? ""} placeholder="Name or SKU" />
        </FilterField>
        <FilterField id="warehouseId" label="Warehouse">
          <Select id="warehouseId" name="warehouseId" defaultValue={warehouseId ?? ""}>
            <option value="">All warehouses</option>
            {selectableWarehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      {!balances.ok ? (
        <LoadFailure status={balances.status} message={balances.message} what="stock balances" />
      ) : rows.length === 0 ? (
        <EmptyState title={q || warehouseId ? "No stock matches these filters" : "No stock recorded yet"}>
          Balances appear once stock has been received or adjusted into a warehouse.
        </EmptyState>
      ) : (
        <Card>
          {!items.available ? <Notice tone="warning" className="m-3">Item names couldn&apos;t be loaded; showing short ids.</Notice> : null}
          <Table>
            <THead>
              <tr>
                <TH>Item</TH>
                <TH>Warehouse</TH>
                <TH className="text-right">On hand</TH>
                {showCost ? <TH className="text-right">Average cost</TH> : null}
                <TH></TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((b) => {
                const it = items.byId.get(b.itemId);
                return (
                  <TR key={`${b.itemId}-${b.warehouseId}`}>
                    <TD>
                      <Link href={`/catalog/items/${b.itemId}`} className="font-medium text-primary hover:underline">{it?.name ?? `Item ${b.itemId.slice(0, 8)}`}</Link>
                      {it ? <span className="ml-1.5 font-mono text-xs text-muted-foreground">{it.sku}</span> : null}
                    </TD>
                    <TD>{whName(b.warehouseId)}</TD>
                    <TD className="text-right"><Quantity value={b.quantity} uom={it?.uom} /></TD>
                    {showCost ? <TD className="text-right"><Money amount={b.averageUnitCost ?? null} currency={b.averageUnitCostCurrency} unavailableReason="no cost recorded" /></TD> : null}
                    <TD className="text-right">
                      <Link href={`/inventory/movements?itemId=${b.itemId}&warehouseId=${b.warehouseId}`} className="text-xs text-primary hover:underline">History</Link>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {rows.length} stock line{rows.length === 1 ? "" : "s"}. Items that have never been received don&apos;t appear here.
          </p>
        </Card>
      )}
    </>
  );
}
