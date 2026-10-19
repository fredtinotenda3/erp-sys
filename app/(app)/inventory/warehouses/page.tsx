import { listStockBalances } from "../../../../src/server/modules/inventory/stock-service";
import { WarehouseForm } from "../../../../components/features/inventory/warehouse-form";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, EmptyState, ErrorState } from "../../../../components/ui/states";
import { ActiveBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { getPageContext, load } from "../../../../lib/server/page-context";
import { loadWarehouses } from "../../../../lib/server/lookups";
import type { StockBalance } from "../../../../lib/api-types";

export const metadata = { title: "Warehouses · Operis" };

export default async function WarehousesPage() {
  const ctx = await getPageContext();
  if (!ctx.can("stock:read")) return <AccessDenied what="warehouses" />;

  const [warehouses, balances] = await Promise.all([loadWarehouses(ctx), load<StockBalance[]>(() => listStockBalances(ctx.session, {}))]);
  if (!warehouses.available) return <ErrorState message="The warehouse list couldn't be loaded. Try again in a moment." />;

  const lines = new Map<string, number>();
  if (balances.ok) for (const b of balances.data) lines.set(b.warehouseId, (lines.get(b.warehouseId) ?? 0) + 1);
  const list = warehouses.list.filter((w) => !ctx.selectedBranchId || w.branchId === ctx.selectedBranchId);

  return (
    <>
      <PageHeader title="Warehouses" description="Where stock is held. Each warehouse belongs to one branch." />
      {list.length === 0 ? (
        <EmptyState title="No warehouses yet">Add a warehouse before receiving stock.</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Warehouse</TH>
                <TH>Branch</TH>
                <TH className="text-right">Stock lines</TH>
                <TH>Status</TH>
                <TH></TH>
              </tr>
            </THead>
            <TBody>
              {list.map((w) => (
                <TR key={w.id}>
                  <TD className="font-medium">{w.name}</TD>
                  <TD>{ctx.branchName(w.branchId)}</TD>
                  <TD className="text-right">{balances.ok ? (lines.get(w.id) ?? 0) : <span className="text-muted-foreground">—</span>}</TD>
                  <TD><ActiveBadge active={w.isActive} /></TD>
                  <TD className="text-right">
                    <Link href={`/inventory/stock?warehouseId=${w.id}`} className="text-xs text-primary hover:underline">View stock</Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      {ctx.can("warehouse:create") ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Add a warehouse</CardTitle>
          </CardHeader>
          <CardContent>
            <WarehouseForm branches={ctx.me.branches} defaultBranchId={ctx.selectedBranchId} />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
