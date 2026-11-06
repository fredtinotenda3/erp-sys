import Link from "next/link";

import { MouldForm } from "../../../../components/features/production/mould-form";
import { Card } from "../../../../components/ui/card";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, EmptyState, ErrorState } from "../../../../components/ui/states";
import { ActiveBadge, MouldStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { getPageContext } from "../../../../lib/server/page-context";
import { loadItems, loadMoulds } from "../../../../lib/server/lookups";
import { PRODUCIBLE } from "../../../../lib/labels";

export const metadata = { title: "Moulds · Operis" };

export default async function MouldsPage() {
  const ctx = await getPageContext();
  if (!ctx.can("mould:read")) return <AccessDenied what="moulds" />;

  const [moulds, items] = await Promise.all([
    loadMoulds(ctx, ctx.selectedBranchId ? { branchId: ctx.selectedBranchId } : {}),
    loadItems(ctx),
  ]);
  if (!moulds.available) return <ErrorState message="The mould register couldn't be loaded. Try again in a moment." />;

  const canManage = ctx.can("mould:manage");
  const products = items.available ? items.list.filter((i) => PRODUCIBLE.includes(i.itemType)) : [];

  return (
    <>
      <PageHeader title="Moulds" description="The mould register: cavity count, product fit, status and maintenance history." />

      {ctx.me.industryProfile !== "plastics" ? (
        <Notice tone="neutral" title="Not on the plastics profile">
          This organization&apos;s manufacturing profile is &quot;{ctx.me.industryProfile}&quot;, not plastics. Existing moulds stay fully visible, but new moulds
          can&apos;t be added or changed until the plastics profile is selected in Settings → Manufacturing profile.
        </Notice>
      ) : null}

      {moulds.list.length === 0 ? (
        <EmptyState title="No moulds yet">{canManage ? "Add the first one below." : "None have been registered."}</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Mould</TH>
                <TH>Cavities</TH>
                <TH>Product</TH>
                <TH>Status</TH>
                <TH>Active</TH>
                <TH></TH>
              </tr>
            </THead>
            <TBody>
              {moulds.list.map((m) => (
                <TR key={m.id}>
                  <TD className="font-medium">
                    {m.name} <span className="text-muted-foreground">({m.code})</span>
                  </TD>
                  <TD>{m.cavityCount}</TD>
                  <TD>
                    {m.compatibleProductItemId ? (
                      <Link href={`/catalog/items/${m.compatibleProductItemId}`} className="text-primary hover:underline">
                        {items.byId.get(m.compatibleProductItemId)?.name ?? "Item"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Not set</span>
                    )}
                  </TD>
                  <TD><MouldStatusBadge status={m.status} /></TD>
                  <TD><ActiveBadge active={m.isActive} /></TD>
                  <TD className="text-right">
                    <Link href={`/production/moulds/${m.id}`} className="text-xs text-primary hover:underline">View</Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {canManage ? (
        <Card className="mt-5 p-4">
          <h2 className="mb-3 text-sm font-semibold">Add a mould</h2>
          <MouldForm branches={ctx.me.branches} defaultBranchId={ctx.selectedBranchId} products={products.map((p) => ({ id: p.id, name: p.name, sku: p.sku }))} />
        </Card>
      ) : null}
    </>
  );
}
