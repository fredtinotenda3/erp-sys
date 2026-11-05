import Link from "next/link";
import { Plus } from "lucide-react";

import { listPurchaseOrders, PURCHASE_ORDER_STATUS_VALUES, type PurchaseOrderStatus } from "../../../../src/server/modules/purchasing/purchase-order-service";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { Select } from "../../../../components/ui/select";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money } from "../../../../components/ui/provenance";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { PurchaseOrderStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { Pagination } from "../../../../components/features/shared/pagination";
import { formatDate, humanize } from "../../../../lib/format";
import { isUuid } from "../../../../lib/validate";
import { getPageContext, load, param } from "../../../../lib/server/page-context";
import { loadSuppliers } from "../../../../lib/server/lookups";

export const metadata = { title: "Purchase orders · Operis" };
const PAGE_SIZE = 25;

interface PoPage {
  total: number;
  rows: { id: string; poNumber: string; branchId: string; supplier: { id: string; name: string }; status: string; currency: string; total?: string; requestedDeliveryDate: string | null; lines: unknown[] }[];
}

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("purchase_order:read")) return <AccessDenied what="purchase orders" />;

  const sp = await searchParams;
  const sParam = param(sp.status);
  const status = sParam && (PURCHASE_ORDER_STATUS_VALUES as readonly string[]).includes(sParam) ? (sParam as PurchaseOrderStatus) : undefined;
  const supParam = param(sp.supplierId);
  const supplierId = supParam && isUuid(supParam) ? supParam : undefined;
  const search = param(sp.q)?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);

  const [orders, suppliers] = await Promise.all([
    load<PoPage>(() => listPurchaseOrders(ctx.session, { status, supplierId, search, branchId: ctx.selectedBranchId ?? undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })),
    ctx.can("supplier:read") ? loadSuppliers(ctx) : Promise.resolve(null),
  ]);
  const filtered = Boolean(status || supplierId || search);
  const multiBranch = ctx.me.branches.length > 1;
  const canSeeCost = ctx.can("cost:read");

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="Purchase orders record what was asked of a supplier. Confirming one allows goods to be received against it."
        actions={ctx.can("purchase_order:create") ? <Link href="/purchasing/orders/new" className={buttonVariants()}><Plus /> New purchase order</Link> : null}
      />
      <FilterBar resetHref="/purchasing/orders">
        <FilterField id="q" label="PO number or supplier"><Input id="q" name="q" defaultValue={search ?? ""} /></FilterField>
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {PURCHASE_ORDER_STATUS_VALUES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </Select>
        </FilterField>
        {suppliers?.available ? (
          <FilterField id="supplierId" label="Supplier">
            <Select id="supplierId" name="supplierId" defaultValue={supplierId ?? ""}>
              <option value="">All suppliers</option>
              {suppliers.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </FilterField>
        ) : null}
      </FilterBar>

      {!orders.ok ? (
        <LoadFailure status={orders.status} message={orders.message} what="purchase orders" />
      ) : orders.data.total === 0 ? (
        <EmptyState title={filtered ? "No purchase orders match these filters" : "No purchase orders yet"} action={!filtered && ctx.can("purchase_order:create") ? <Link href="/purchasing/orders/new" className={buttonVariants()}>Create the first purchase order</Link> : null}>
          {filtered ? "Clear the filters to see every purchase order." : "Create a purchase order for a supplier, confirm it, then record what arrives against it."}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>PO</TH><TH>Supplier</TH>{multiBranch ? <TH>Branch</TH> : null}<TH>Status</TH><TH>Delivery requested</TH><TH className="text-right">Lines</TH>{canSeeCost ? <TH className="text-right">Total</TH> : null}
              </tr>
            </THead>
            <TBody>
              {orders.data.rows.map((o) => (
                <TR key={o.id}>
                  <TD><Link href={`/purchasing/orders/${o.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{o.poNumber}</Link></TD>
                  <TD>{o.supplier.name}</TD>
                  {multiBranch ? <TD>{ctx.branchName(o.branchId)}</TD> : null}
                  <TD><PurchaseOrderStatusBadge status={o.status} /></TD>
                  <TD>{formatDate(o.requestedDeliveryDate)}</TD>
                  <TD className="text-right">{o.lines.length}</TD>
                  {canSeeCost ? <TD className="text-right">{o.total !== undefined ? <Money amount={o.total} currency={o.currency} /> : "—"}</TD> : null}
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination basePath="/purchasing/orders" params={{ q: search, status, supplierId }} page={page} pageSize={PAGE_SIZE} total={orders.data.total} />
        </Card>
      )}
    </>
  );
}
