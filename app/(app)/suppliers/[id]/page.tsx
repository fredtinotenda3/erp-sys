import Link from "next/link";
import { Pencil } from "lucide-react";

import { getSupplierById } from "../../../../src/server/modules/suppliers/supplier-service";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../components/ui/states";
import { ActiveBadge } from "../../../../components/ui/status-badge";
import { formatDate } from "../../../../lib/format";
import { getPageContext, load } from "../../../../lib/server/page-context";

export const metadata = { title: "Supplier · Operis" };

interface Supp { id: string; name: string; status: "active" | "inactive"; contact: string | null; address: string | null; notes: string | null; createdAt: string }

// No related-records section yet (Customer's detail page shows sales orders
// and production jobs because those modules exist). Once Purchasing/POs ship
// — the next milestone in Stanley's ordered list — add a "Purchase orders"
// section here following the exact pattern Customer's page uses for orders.
export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("supplier:read")) return <AccessDenied what="suppliers" />;
  const { id } = await params;
  const s = await load<Supp>(() => getSupplierById(ctx.session, id));
  if (!s.ok) return <LoadFailure status={s.status} message={s.message} what="this supplier" />;
  const su = s.data;

  return (
    <>
      <PageHeader
        title={<>{su.name} <ActiveBadge active={su.status === "active"} /></>}
        crumbs={[{ label: "Suppliers", href: "/suppliers" }, { label: su.name }]}
        meta={<span>Added {formatDate(su.createdAt)}</span>}
        actions={ctx.can("supplier:update") ? <Link href={`/suppliers/${su.id}/edit`} className={buttonVariants({ variant: "outline" })}><Pencil /> Edit</Link> : null}
      />
      <Card className="p-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-muted-foreground">Contact</dt><dd>{su.contact || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Address</dt><dd className="whitespace-pre-line">{su.address || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Notes</dt><dd className="whitespace-pre-line">{su.notes || "—"}</dd></div>
        </dl>
      </Card>
    </>
  );
}
