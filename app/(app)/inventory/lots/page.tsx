import Link from "next/link";

import { listLots } from "../../../../src/server/modules/inventory/lot-service";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { LotStatusBadge } from "../../../../components/ui/status-badge";
import { PageHeader } from "../../../../components/ui/page-header";
import { Select } from "../../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { formatDate, formatQuantity } from "../../../../lib/format";
import { getPageContext, load, param, UUID_RE } from "../../../../lib/server/page-context";
import { itemLabel, loadItems, loadSuppliers, loadWarehouses } from "../../../../lib/server/lookups";
import type { MaterialLot } from "../../../../lib/api-types";

export const metadata = { title: "Material lots · Operis" };

export default async function LotsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("lot:read")) return <AccessDenied what="material lots" />;

  const sp = await searchParams;
  const uuid = (v: string | undefined) => (v && UUID_RE.test(v) ? v : undefined);
  const itemId = uuid(param(sp.itemId));
  const warehouseId = uuid(param(sp.warehouseId));
  const supplierId = uuid(param(sp.supplierId));
  const status = param(sp.status);
  const search = param(sp.search);

  const [lots, items, warehouses, suppliers] = await Promise.all([
    load<MaterialLot[]>(() => listLots(ctx.session, { itemId, warehouseId, supplierId, status, search, limit: 300 })),
    loadItems(ctx),
    loadWarehouses(ctx),
    loadSuppliers(ctx),
  ]);
  const branchId = ctx.selectedBranchId;
  const selectableWarehouses = warehouses.list.filter((w) => !branchId || w.branchId === branchId);

  return (
    <>
      <PageHeader
        title="Material lots"
        crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Material lots" }]}
        description="Every received or returned lot, with what's still left to draw from it. Open a lot to see its full traceability chain."
      />

      <FilterBar resetHref="/inventory/lots">
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
        <FilterField id="supplierId" label="Supplier">
          <Select id="supplierId" name="supplierId" defaultValue={supplierId ?? ""}>
            <option value="">All suppliers</option>
            {suppliers.list.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </FilterField>
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="quarantined">Quarantined</option>
            <option value="expired">Expired</option>
          </Select>
        </FilterField>
        <FilterField id="search" label="Lot / supplier ref">
          <Input id="search" name="search" defaultValue={search ?? ""} placeholder="LOT-000123" />
        </FilterField>
      </FilterBar>

      {!lots.ok ? (
        <LoadFailure status={lots.status} message={lots.message} what="material lots" />
      ) : lots.data.length === 0 ? (
        <EmptyState title="No lot matches">Try clearing the filters.</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Lot</TH>
                <TH>Item</TH>
                <TH>Warehouse</TH>
                <TH>Supplier</TH>
                <TH>Status</TH>
                <TH className="text-right">Received</TH>
                <TH className="text-right">Remaining</TH>
                <TH>Expiry</TH>
              </tr>
            </THead>
            <TBody>
              {lots.data.map((l) => {
                const it = items.byId.get(l.itemId);
                return (
                  <TR key={l.id}>
                    <TD>
                      <Link href={`/inventory/lots/${l.id}`} className="font-medium text-primary hover:underline">
                        {l.lotNumber}
                      </Link>
                    </TD>
                    <TD>{itemLabel(it, l.itemId)}</TD>
                    <TD>{warehouses.byId.get(l.warehouseId)?.name ?? "Warehouse"}</TD>
                    <TD>{suppliers.byId.get(l.supplierId)?.name ?? (suppliers.available ? "Unknown supplier" : "—")}</TD>
                    <TD><LotStatusBadge status={l.status} /></TD>
                    <TD className="text-right tabular-nums">{formatQuantity(l.quantityReceived, l.uom)}</TD>
                    <TD className={`text-right font-medium tabular-nums ${Number(l.remaining) <= 0 ? "text-muted-foreground" : ""}`}>{formatQuantity(l.remaining, l.uom)}</TD>
                    <TD>{l.expiryDate ? formatDate(l.expiryDate) : <span className="text-muted-foreground">—</span>}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing the latest {lots.data.length} lot{lots.data.length === 1 ? "" : "s"}.</p>
        </Card>
      )}
    </>
  );
}
