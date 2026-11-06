import { getFinishedGoodsValuation } from "../../../../src/server/modules/inventory/finished-goods-service";
import { Card } from "../../../../components/ui/card";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../components/ui/provenance";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { getPageContext, load } from "../../../../lib/server/page-context";
import type { FinishedGoodsValuationRow } from "../../../../lib/api-types";

export const metadata = { title: "Finished-goods valuation · Operis" };

// Rolls up the finished-goods (and WIP-item) stock_balance rows -- the SAME
// cache the stock ledger trigger already maintains, never a second,
// independently-computed total -- by item and warehouse. See
// finished-goods-service.ts's getFinishedGoodsValuation.
export default async function FinishedGoodsValuationReportPage() {
  const ctx = await getPageContext();
  if (!ctx.can("finished_goods:read")) return <AccessDenied what="the finished-goods valuation report" />;
  const showCost = ctx.can("cost:read");

  const res = await load<FinishedGoodsValuationRow[]>(() => getFinishedGoodsValuation(ctx.session));
  const rows = res.ok ? res.data : [];
  const totalsByCurrency = new Map<string, number>();
  if (showCost) {
    for (const r of rows) {
      if (r.totalValue === null || r.totalValue === undefined || !r.averageUnitCostCurrency) continue;
      totalsByCurrency.set(r.averageUnitCostCurrency, (totalsByCurrency.get(r.averageUnitCostCurrency) ?? 0) + Number(r.totalValue));
    }
  }

  return (
    <>
      <PageHeader
        title="Finished-goods valuation"
        crumbs={[{ label: "Reports", href: "/reports" }, { label: "Finished-goods valuation" }]}
        description="Current on-hand finished-goods and WIP-item stock, by item and warehouse, valued at the stock ledger's own weighted-average cost -- an operational inventory valuation, not a general-ledger figure."
      />
      {!res.ok ? (
        <LoadFailure status={res.status} message={res.message} what="the finished-goods valuation report" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing on hand">No finished-goods or WIP-item stock balance exists in your scope yet.</EmptyState>
      ) : (
        <>
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH>Item</TH>
                  <TH>Warehouse</TH>
                  <TH className="text-right">On hand</TH>
                  {showCost ? <TH className="text-right">Average unit cost</TH> : null}
                  {showCost ? <TH className="text-right">Total value</TH> : null}
                </tr>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={`${r.itemId}-${r.warehouseId}`}>
                    <TD>
                      {r.itemName} ({r.sku})
                    </TD>
                    <TD>{r.warehouseName}</TD>
                    <TD className="text-right">
                      <Quantity value={r.quantity} uom={r.uom} />
                    </TD>
                    {showCost ? (
                      <TD className="text-right">
                        <Money amount={r.averageUnitCost ?? null} currency={r.averageUnitCostCurrency} unavailableReason="no cost basis yet" />
                      </TD>
                    ) : null}
                    {showCost ? (
                      <TD className="text-right font-medium">
                        <Money amount={r.totalValue ?? null} currency={r.averageUnitCostCurrency} unavailableReason="no cost basis yet" />
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Showing {rows.length} item/warehouse balance{rows.length === 1 ? "" : "s"}.</p>
          </Card>
          {showCost && totalsByCurrency.size > 0 ? (
            <div className="mt-4 flex flex-wrap gap-4">
              {[...totalsByCurrency.entries()].map(([currency, total]) => (
                <Card key={currency} className="p-4">
                  <p className="text-xs text-muted-foreground">Total value ({currency})</p>
                  <p className="text-lg font-semibold tabular-nums">
                    <Money amount={total.toFixed(4)} currency={currency} />
                  </p>
                </Card>
              ))}
            </div>
          ) : null}
          <Notice tone="neutral" className="mt-4">
            Rolled up by currency only -- balances priced in more than one currency are never summed into a single converted figure here.
          </Notice>
        </>
      )}
    </>
  );
}
