import Link from "next/link";
import { Pencil } from "lucide-react";

import { getSupplierById } from "../../../../src/server/modules/suppliers/supplier-service";
import { listOrdersForSupplier } from "../../../../src/server/modules/purchasing/purchase-order-service";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money } from "../../../../components/ui/provenance";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../components/ui/states";
import { ActiveBadge, PurchaseOrderStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { formatDate } from "../../../../lib/format";
import { getPageContext, load } from "../../../../lib/server/page-context";

export const metadata = { title: "Supplier · Operis" };

interface Supp { id: string; name: string; status: "active" | "inactive"; contact: string | null; address: string | null; notes: string | null; createdAt: string }
interface PoList { total: number; rows: { id: string; poNumber: string; status: string; currency: string; total?: string; requestedDeliveryDate: string | null }[] }

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("supplier:read")) return <AccessDenied what="suppliers" />;
  const { id } = await params;
  const s = await load<Supp>(() => getSupplierById(ctx.session, id));
  if (!s.ok) return <LoadFailure status={s.status} message={s.message} what="this supplier" />;
  const su = s.data;

  // Related records are an optional extra, same pattern Customer's detail
  // page uses for its sales orders: shown only if the role may read it, and
  // a failure to load doesn't hide the supplier itself.
  const orders = ctx.can("purchase_order:read") ? await load<PoList>(() => listOrdersForSupplier(ctx.session, id, 10)) : null;
  const canSeeCost = ctx.can("cost:read");

  return (
    <>
      <PageHeader
        title={<>{su.name} <ActiveBadge active={su.status === "active"} /></>}
        crumbs={[{ label: "Suppliers", href: "/suppliers" }, { label: su.name }]}
        meta={<span>Added {formatDate(su.createdAt)}</span>}
        actions={ctx.can("supplier:update") ? <Link href={`/suppliers/${su.id}/edit`} className={buttonVariants({ variant: "outline" })}><Pencil /> Edit</Link> : null}
      />
      <Card className="mb-5 p-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">Contact</dt><dd>{su.contact || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Address</dt><dd className="whitespace-pre-line">{su.address || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Notes</dt><dd className="whitespace-pre-line">{su.notes || "—"}</dd></div>
        </dl>
      </Card>

      {orders ? (
        <section aria-labelledby="po-h">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="po-h" className="text-sm font-semibold">Purchase orders</h2>
            {orders.ok && orders.data.total > 0 ? <Link href={`/purchasing/orders?supplierId=${su.id}`} className="text-xs text-primary hover:underline">View all {orders.data.total}</Link> : null}
          </div>
          {!orders.ok ? <ErrorState title="Purchase orders couldn't be loaded" message={orders.message} /> : orders.data.rows.length === 0 ? (
            <Card className="p-4 text-sm text-muted-foreground">No purchase orders for this supplier yet.</Card>
          ) : (
            <Card>
              <Table>
                <THead><tr><TH>PO</TH><TH>Status</TH><TH>Delivery requested</TH>{canSeeCost ? <TH className="text-right">Total</TH> : null}</tr></THead>
                <TBody>
                  {orders.data.rows.map((o) => (
                    <TR key={o.id}>
                      <TD><Link href={`/purchasing/orders/${o.id}`} className="font-medium text-primary hover:underline">{o.poNumber}</Link></TD>
                      <TD><PurchaseOrderStatusBadge status={o.status} /></TD>
                      <TD>{formatDate(o.requestedDeliveryDate)}</TD>
                      {canSeeCost ? <TD className="text-right">{o.total !== undefined ? <Money amount={o.total} currency={o.currency} /> : "—"}</TD> : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          )}
        </section>
      ) : null}
    </>
  );
}
