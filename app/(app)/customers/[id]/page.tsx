import Link from "next/link";
import { Pencil } from "lucide-react";

import { getCustomerById } from "../../../../src/server/modules/customers/customer-service";
import { listSalesOrders } from "../../../../src/server/modules/sales/sales-order-service";
import { listJobs } from "../../../../src/server/modules/production/job-service";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money } from "../../../../components/ui/provenance";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../components/ui/states";
import { ActiveBadge, JobStatusBadge, OrderStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { formatDate } from "../../../../lib/format";
import { getPageContext, load } from "../../../../lib/server/page-context";

export const metadata = { title: "Customer · Operis" };

interface Cust { id: string; name: string; status: "active" | "inactive"; contact: string | null; address: string | null; notes: string | null; createdAt: string }
interface OrderList { total: number; rows: { id: string; orderNumber: string; status: string; total: string; currency: string; requestedDeliveryDate: string | null }[] }
interface JobRow { id: string; jobNumber: string; status: string; plannedQty: string }

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("customer:read")) return <AccessDenied what="customers" />;
  const { id } = await params;
  const c = await load<Cust>(() => getCustomerById(ctx.session, id));
  if (!c.ok) return <LoadFailure status={c.status} message={c.message} what="this customer" />;

  // Related records are optional extras: each is shown only if the role may read it, and a
  // failure to load one is reported without hiding the customer.
  const [orders, jobs] = await Promise.all([
    ctx.can("sales_order:read") ? load<OrderList>(() => listSalesOrders(ctx.session, { customerId: id, limit: 10 })) : Promise.resolve(null),
    ctx.can("production_job:read") ? load<JobRow[]>(() => listJobs(ctx.session, { customerId: id, limit: 10 })) : Promise.resolve(null),
  ]);
  const cu = c.data;

  return (
    <>
      <PageHeader
        title={<>{cu.name} <ActiveBadge active={cu.status === "active"} /></>}
        crumbs={[{ label: "Customers", href: "/customers" }, { label: cu.name }]}
        meta={<span>Added {formatDate(cu.createdAt)}</span>}
        actions={ctx.can("customer:update") ? <Link href={`/customers/${cu.id}/edit`} className={buttonVariants({ variant: "outline" })}><Pencil /> Edit</Link> : null}
      />
      <Card className="mb-5 p-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">Contact</dt><dd>{cu.contact || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Address</dt><dd className="whitespace-pre-line">{cu.address || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Notes</dt><dd className="whitespace-pre-line">{cu.notes || "—"}</dd></div>
        </dl>
      </Card>

      {orders ? (
        <section className="mb-5" aria-labelledby="orders-h">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="orders-h" className="text-sm font-semibold">Sales orders</h2>
            {orders.ok && orders.data.total > 0 ? <Link href={`/orders?customerId=${cu.id}`} className="text-xs text-primary hover:underline">View all {orders.data.total}</Link> : null}
          </div>
          {!orders.ok ? <ErrorState title="Orders couldn't be loaded" message={orders.message} /> : orders.data.rows.length === 0 ? (
            <Card className="p-4 text-sm text-muted-foreground">No orders for this customer yet.</Card>
          ) : (
            <Card>
              <Table>
                <THead><tr><TH>Order</TH><TH>Status</TH><TH>Delivery requested</TH><TH className="text-right">Total</TH></tr></THead>
                <TBody>
                  {orders.data.rows.map((o) => (
                    <TR key={o.id}>
                      <TD><Link href={`/orders/${o.id}`} className="font-medium text-primary hover:underline">{o.orderNumber}</Link></TD>
                      <TD><OrderStatusBadge status={o.status} /></TD>
                      <TD>{formatDate(o.requestedDeliveryDate)}</TD>
                      <TD className="text-right"><Money amount={o.total} currency={o.currency} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          )}
        </section>
      ) : null}

      {jobs ? (
        <section aria-labelledby="jobs-h">
          <h2 id="jobs-h" className="mb-2 text-sm font-semibold">Production jobs</h2>
          {!jobs.ok ? <ErrorState title="Jobs couldn't be loaded" message={jobs.message} /> : jobs.data.length === 0 ? (
            <Card className="p-4 text-sm text-muted-foreground">No production jobs for this customer yet.</Card>
          ) : (
            <Card>
              <Table>
                <THead><tr><TH>Job</TH><TH>Status</TH><TH className="text-right">Planned qty</TH></tr></THead>
                <TBody>
                  {jobs.data.map((j) => (
                    <TR key={j.id}>
                      <TD><Link href={`/production/jobs/${j.id}`} className="font-medium text-primary hover:underline">{j.jobNumber}</Link></TD>
                      <TD><JobStatusBadge status={j.status} /></TD>
                      <TD className="text-right">{j.plannedQty}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {jobs.data.length >= 10 ? <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing the 10 most recent jobs.</p> : null}
            </Card>
          )}
        </section>
      ) : null}
    </>
  );
}
