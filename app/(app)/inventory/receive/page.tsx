import { ReceiveForm } from "../../../../components/features/inventory/receive-form";
import { PageHeader } from "../../../../components/ui/page-header";
import { Notice } from "../../../../components/ui/notice";
import { AccessDenied, ErrorState } from "../../../../components/ui/states";
import { RECEIVABLE } from "../../../../lib/labels";
import { getPageContext } from "../../../../lib/server/page-context";
import { loadCurrencies, loadItems, loadWarehouses } from "../../../../lib/server/lookups";

export const metadata = { title: "Receive stock · Operis" };

export default async function ReceivePage() {
  const ctx = await getPageContext();
  if (!ctx.can("stock:receive") || !ctx.can("item:read")) return <AccessDenied what="stock receipts" />;
  const [items, warehouses, currencies] = await Promise.all([loadItems(ctx, { isActive: true }), loadWarehouses(ctx), loadCurrencies()]);
  if (!items.available || !warehouses.available || currencies.length === 0) return <ErrorState message="The items, warehouses or currencies needed for this form couldn't be loaded. Try again in a moment." />;

  const whs = warehouses.list.filter((w) => w.isActive && (!ctx.selectedBranchId || w.branchId === ctx.selectedBranchId));
  return (
    <>
      <PageHeader title="Receive stock" crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Receive stock" }]} description="Record material arriving into a warehouse, with what it cost and in which currency." />
      {whs.length === 0 ? (
        <Notice tone="warning">There is no active warehouse{ctx.selectedBranchId ? ` in ${ctx.branchName(ctx.selectedBranchId)}` : ""} to receive into. Add one under Warehouses.</Notice>
      ) : (
        <ReceiveForm
          items={items.list.filter((i) => RECEIVABLE.includes(i.itemType)).map((i) => ({ id: i.id, label: `${i.name} (${i.sku})`, uom: i.uom }))}
          warehouses={whs.map((w) => ({ id: w.id, name: ctx.me.branches.length > 1 ? `${w.name} — ${ctx.branchName(w.branchId)}` : w.name }))}
          currencies={currencies}
        />
      )}
    </>
  );
}
