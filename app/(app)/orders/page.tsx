import Link from "next/link";
import { Plus } from "lucide-react";

import { listSalesOrders, SALES_ORDER_STATUS_VALUES, type SalesOrderStatus } from "../../../src/server/modules/sales/sales-order-service";
import { buttonVariants } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { PageHeader } from "../../../components/ui/page-header";
import { Money } from "../../../components/ui/provenance";
import { AccessDenied, EmptyState, LoadFailure } from "../../../components/ui/states";
import { OrderStatusBadge } from "../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/table";
import { FilterBar, FilterField } from "../../../components/features/shared/filter-bar";
import { Pagination } from "../../../components/features/shared/pagination";
import { formatDate, humanize } from "../../../lib/format";
import { isUuid } from "../../../lib/validate";
import { getPageContext, load, param } from "../../../lib/server/page-context";
import { loadCustomers } from "../../../lib/server/lookups";

export const metadata = { title: "Sales orders · Operis" };
const PAGE_SIZE = 25;

interface OrderPage {
  total: number;
  rows: { id: string; orderNumber: string; branchId: string; customer: { id: string; name: string }; status: string; currency: string; total: string; requestedDeliveryDate: string | null; lines: { productionJob?: { id: string } | null }[] }[];
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("sales_order:read")) return <AccessDenied what="sales orders" />;

  const sp = await searchParams;
  const sParam = param(sp.status);
  const status = sParam && (SALES_ORDER_STATUS_VALUES as readonly string[]).includes(sParam) ? (sParam as SalesOrderStatus) : undefined;
  const cParam = param(sp.customerId);
  const customerId = cParam && isUuid(cParam) ? cParam : undefined;
  const search = param(sp.q)?.trim() || undefined;
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);

  const [orders, customers] = await Promise.all([
    load<OrderPage>(() => listSalesOrders(ctx.session, { status, customerId, search, branchId: ctx.selectedBranchId ?? undefined, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })),
    ctx.can("customer:read") ? loadCustomers(ctx) : Promise.resolve(null),
  ]);
  const filtered = Boolean(status || customerId || search);
  const multiBranch = ctx.me.branches.length > 1;

  return (
    <>
      <PageHeader
        title="Sales orders"
        description="Orders record what a customer asked for. Creating or confirming one never starts production — work is released line by line."
        actions={ctx.can("sales_order:create") ? <Link href="/orders/new" className={buttonVariants()}><Plus /> New order</Link> : null}
      />
      <FilterBar resetHref="/orders">
        <FilterField id="q" label="Order number or customer"><Input id="q" name="q" defaultValue={search ?? ""} /></FilterField>
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {SALES_ORDER_STATUS_VALUES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
          </Select>
        </FilterField>
        {customers?.available ? (
          <FilterField id="customerId" label="Customer">
            <Select id="customerId" name="customerId" defaultValue={customerId ?? ""}>
              <option value="">All customers</option>
              {customers.list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </FilterField>
        ) : null}
      </FilterBar>

      {!orders.ok ? (
        <LoadFailure status={orders.status} message={orders.message} what="sales orders" />
      ) : orders.data.total === 0 ? (
        <EmptyState title={filtered ? "No orders match these filters" : "No sales orders yet"} action={!filtered && ctx.can("sales_order:create") ? <Link href="/orders/new" className={buttonVariants()}>Create the first order</Link> : null}>
          {filtered ? "Clear the filters to see every order." : "Create an order for a customer, confirm it, then release its lines into production."}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Order</TH><TH>Customer</TH>{multiBranch ? <TH>Branch</TH> : null}<TH>Status</TH><TH>Delivery requested</TH><TH className="text-right">Lines</TH><TH className="text-right">Total</TH>
              </tr>
            </THead>
            <TBody>
              {orders.data.rows.map((o) => (
                <TR key={o.id}>
                  <TD><Link href={`/orders/${o.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{o.orderNumber}</Link></TD>
                  <TD>{o.customer.name}</TD>
                  {multiBranch ? <TD>{ctx.branchName(o.branchId)}</TD> : null}
                  <TD><OrderStatusBadge status={o.status} /></TD>
                  <TD>{formatDate(o.requestedDeliveryDate)}</TD>
                  <TD className="text-right">{o.lines.length}</TD>
                  <TD className="text-right"><Money amount={o.total} currency={o.currency} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination basePath="/orders" params={{ q: search, status, customerId }} page={page} pageSize={PAGE_SIZE} total={orders.data.total} />
        </Card>
      )}
    </>
  );
}
