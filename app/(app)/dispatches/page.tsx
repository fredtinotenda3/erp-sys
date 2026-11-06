import Link from "next/link";

import { listDispatches } from "../../../src/server/modules/inventory/dispatch-service";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { DispatchStatusBadge } from "../../../components/ui/status-badge";
import { PageHeader } from "../../../components/ui/page-header";
import { Select } from "../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/table";
import { FilterBar, FilterField } from "../../../components/features/shared/filter-bar";
import { formatDateTimeLocal } from "../../../lib/format";
import { getPageContext, load, param, UUID_RE } from "../../../lib/server/page-context";
import { loadWarehouses } from "../../../lib/server/lookups";
import type { Dispatch } from "../../../lib/api-types";

export const metadata = { title: "Dispatches · Operis" };

export default async function DispatchesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("dispatch:read")) return <AccessDenied what="dispatches" />;

  const sp = await searchParams;
  const uuid = (v: string | undefined) => (v && UUID_RE.test(v) ? v : undefined);
  const warehouseId = uuid(param(sp.warehouseId));
  const status = param(sp.status);
  const search = param(sp.search);

  const [dispatches, warehouses] = await Promise.all([
    load<{ total: number; rows: Dispatch[] }>(() => listDispatches(ctx.session, { warehouseId, status: status === "dispatched" || status === "delivered" ? status : undefined, search, limit: 100 })),
    loadWarehouses(ctx),
  ]);
  const branchId = ctx.selectedBranchId;
  const selectableWarehouses = warehouses.list.filter((w) => !branchId || w.branchId === branchId);

  return (
    <>
      <PageHeader
        title="Dispatches"
        crumbs={[{ label: "Orders", href: "/orders" }, { label: "Dispatches" }]}
        description="Shipments against sales orders, fulfilled from finished-goods stock. Open a dispatch to see which batch(es) it drew from and confirm its delivery."
      />

      <FilterBar resetHref="/dispatches">
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
            <option value="dispatched">Dispatched</option>
            <option value="delivered">Delivered</option>
          </Select>
        </FilterField>
        <FilterField id="search" label="Search" className="min-w-52 flex-1">
          <Input id="search" name="search" defaultValue={search ?? ""} placeholder="Dispatch #, order #, or customer" />
        </FilterField>
      </FilterBar>

      {!dispatches.ok ? (
        <LoadFailure status={dispatches.status} message={dispatches.message} what="dispatches" />
      ) : dispatches.data.rows.length === 0 ? (
        <EmptyState title="No dispatch matches">Try clearing the filters, or dispatch a confirmed order from its own page.</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Dispatch</TH>
                <TH>Order</TH>
                <TH>Customer</TH>
                <TH>Warehouse</TH>
                <TH>Status</TH>
                <TH>Dispatched</TH>
              </tr>
            </THead>
            <TBody>
              {dispatches.data.rows.map((d) => (
                <TR key={d.id}>
                  <TD>
                    <Link href={`/dispatches/${d.id}`} className="font-medium text-primary hover:underline">
                      {d.dispatchNumber}
                    </Link>
                  </TD>
                  <TD>
                    {ctx.can("sales_order:read") ? (
                      <Link href={`/orders/${d.salesOrderId}`} className="text-primary hover:underline">
                        {d.orderNumber}
                      </Link>
                    ) : (
                      d.orderNumber
                    )}
                  </TD>
                  <TD>{d.customer.name}</TD>
                  <TD>{d.warehouseName}</TD>
                  <TD>
                    <DispatchStatusBadge status={d.status} />
                  </TD>
                  <TD>{formatDateTimeLocal(d.dispatchedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing the latest {dispatches.data.rows.length} dispatch{dispatches.data.rows.length === 1 ? "" : "es"}.</p>
        </Card>
      )}
    </>
  );
}
