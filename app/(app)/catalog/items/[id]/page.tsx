import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";

import { getItemById } from "../../../../../src/server/modules/catalog/item-service";
import { toItemView } from "../../../../../src/server/modules/catalog/item-view";
import { listBomVersions } from "../../../../../src/server/modules/catalog/bom-service";
import { listStockBalances } from "../../../../../src/server/modules/inventory/stock-service";
import { ActivateBomButton } from "../../../../../components/features/catalog/activate-bom-button";
import { EditItemDialog } from "../../../../../components/features/catalog/edit-item-dialog";
import { buttonVariants } from "../../../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../../components/ui/provenance";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { ActiveBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { TabsNav } from "../../../../../components/ui/tabs-nav";
import { formatDate, formatQuantity } from "../../../../../lib/format";
import { ITEM_TYPE_LABELS, PRODUCIBLE } from "../../../../../lib/labels";
import { getPageContext, load, param, UUID_RE } from "../../../../../lib/server/page-context";
import { loadCurrencies, loadItems, loadWarehouses } from "../../../../../lib/server/lookups";
import type { Bom, Item, StockBalance } from "../../../../../lib/api-types";

export default async function ItemDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getPageContext();
  if (!ctx.can("item:read")) return <AccessDenied what="the product catalog" />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const itemRes = await load<Item>(async () => toItemView(ctx.session.role, await getItemById(ctx.session, id)));
  if (!itemRes.ok) {
    if (itemRes.status === 404) notFound();
    return <LoadFailure status={itemRes.status} message={itemRes.message} what="this item" />;
  }
  const item = itemRes.data;
  const showCost = ctx.can("cost:read");
  const hasBom = PRODUCIBLE.includes(item.itemType) && ctx.can("bom:read");
  const sp = await searchParams;
  const tab = param(sp.tab) === "bom" && hasBom ? "bom" : "overview";

  const tabs = [
    { key: "overview", label: "Overview", href: `/catalog/items/${id}` },
    ...(hasBom ? [{ key: "bom", label: "Bill of materials", href: `/catalog/items/${id}?tab=bom` }] : []),
  ];

  return (
    <>
      <PageHeader
        title={
          <>
            {item.name} <ActiveBadge active={item.isActive} />
          </>
        }
        crumbs={[{ label: "Products & BOM", href: "/catalog/items" }, { label: item.sku }]}
        meta={
          <>
            <span className="font-mono text-xs">{item.sku}</span>
            <span>{ITEM_TYPE_LABELS[item.itemType]}</span>
            <span>Unit: {item.uom}</span>
          </>
        }
        actions={
          ctx.can("item:update") ? <EditItemDialog item={item} canSeeCost={showCost} currencies={showCost ? await loadCurrencies() : []} /> : null
        }
      />
      <TabsNav tabs={tabs} active={tab} label="Item sections" />
      {tab === "bom" ? <BomTab ctx={ctx} item={item} /> : <OverviewTab ctx={ctx} item={item} showCost={showCost} />}
    </>
  );
}

async function OverviewTab({ ctx, item, showCost }: { ctx: Awaited<ReturnType<typeof getPageContext>>; item: Item; showCost: boolean }) {
  const [balances, warehouses] = await Promise.all([
    ctx.can("stock:read") ? load<StockBalance[]>(() => listStockBalances(ctx.session, { itemId: item.id })) : Promise.resolve(null),
    loadWarehouses(ctx),
  ]);
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">Description</dt>
            <dd>{item.description || <span className="text-muted-foreground">None</span>}</dd>
            <dt className="text-muted-foreground">Reorder level</dt>
            <dd>{item.reorderThreshold ? formatQuantity(item.reorderThreshold, item.uom) : <span className="text-muted-foreground">Not set — never shows as Low</span>}</dd>
            {showCost ? (
              <>
                <dt className="text-muted-foreground">Standard cost</dt>
                <dd>
                  <Money amount={item.standardCost} currency={item.standardCostCurrency} unavailableReason="not set; jobs list this as unpriced" />
                  {item.standardCost ? <span className="text-muted-foreground"> per {item.uom}</span> : null}
                </dd>
                <dt className="text-muted-foreground">Selling price</dt>
                <dd>{item.isSellable ? <Money amount={item.sellingPrice} currency={item.sellingPriceCurrency} /> : <span className="text-muted-foreground">Not sold</span>}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Last updated</dt>
            <dd>{formatDate(item.updatedAt)}</dd>
          </dl>
          {!showCost ? <p className="mt-3 text-xs text-muted-foreground">Cost and price are shown to roles with cost access.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stock on hand</CardTitle>
          <Link href={`/inventory/movements?itemId=${item.id}`} className="text-xs text-primary hover:underline">
            Why is it this number?
          </Link>
        </CardHeader>
        {balances === null ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">Stock levels aren&apos;t available for your role.</p>
          </CardContent>
        ) : !balances.ok ? (
          <CardContent>
            <LoadFailure status={balances.status} message={balances.message} what="stock levels" />
          </CardContent>
        ) : balances.data.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">No stock has been recorded for this item in any warehouse.</p>
          </CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Warehouse</TH>
                <TH className="text-right">On hand</TH>
                {showCost ? <TH className="text-right">Average cost</TH> : null}
              </tr>
            </THead>
            <TBody>
              {balances.data.map((b) => (
                <TR key={b.warehouseId}>
                  <TD>{warehouses.byId.get(b.warehouseId)?.name ?? "Warehouse"}</TD>
                  <TD className="text-right">
                    <Quantity value={b.quantity} uom={item.uom} />
                  </TD>
                  {showCost ? (
                    <TD className="text-right">
                      <Money amount={b.averageUnitCost ?? null} currency={b.averageUnitCostCurrency} unavailableReason="no cost recorded" />
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

async function BomTab({ ctx, item }: { ctx: Awaited<ReturnType<typeof getPageContext>>; item: Item }) {
  const [versions, items] = await Promise.all([load<Bom[]>(() => listBomVersions(ctx.session, item.id)), loadItems(ctx)]);
  if (!versions.ok) return <LoadFailure status={versions.status} message={versions.message} what="the bill of materials" />;

  const active = versions.data.find((v) => v.status === "active") ?? null;
  const others = versions.data.filter((v) => v.id !== active?.id);
  const name = (id: string) => items.byId.get(id);

  const lines = (bom: Bom) => (
    <Table>
      <THead>
        <tr>
          <TH>Material</TH>
          <TH className="text-right">Quantity per unit</TH>
        </tr>
      </THead>
      <TBody>
        {bom.lines.map((l) => {
          const m = name(l.materialItemId);
          return (
            <TR key={l.id}>
              <TD>
                {m ? (
                  <Link href={`/catalog/items/${m.id}`} className="text-primary hover:underline">
                    {m.name} <span className="font-mono text-xs text-muted-foreground">{m.sku}</span>
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Item {l.materialItemId.slice(0, 8)}</span>
                )}
              </TD>
              <TD className="text-right">
                <Quantity value={l.quantity} uom={l.uom} />
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Versions never change once created. To edit, save a new version and activate it.</p>
        {ctx.can("bom:create") ? (
          <Link href={`/catalog/items/${item.id}/bom/new`} className={buttonVariants({ variant: active ? "outline" : "primary" })}>
            <Plus /> New version
          </Link>
        ) : null}
      </div>

      {!active ? (
        <Notice tone="warning" title="No active BOM">
          Production jobs can&apos;t be created for this item until a version is activated.
        </Notice>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              Version {active.version} <span className="ml-1 font-normal text-status-success">· Active</span>
            </CardTitle>
            <span className="text-xs text-muted-foreground">Effective from {formatDate(active.effectiveFrom)}</span>
          </CardHeader>
          {lines(active)}
        </Card>
      )}

      {others.length > 0 ? (
        <section aria-label="Other versions" className="space-y-2">
          <h2 className="text-sm font-semibold">Other versions</h2>
          {others.map((v) => (
            <details key={v.id} className="rounded-lg border border-border bg-card" open={v.status === "draft"}>
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium">
                <span>
                  Version {v.version} <span className="font-normal text-muted-foreground">· {v.status === "draft" ? "Draft, not in use" : "Superseded"}</span>
                </span>
              </summary>
              <div className="border-t border-border">{lines(v)}</div>
              {v.status === "draft" && ctx.can("bom:activate") ? (
                <div className="flex justify-end border-t border-border px-4 py-2.5">
                  <ActivateBomButton itemId={item.id} bomId={v.id} version={v.version} activeVersion={active?.version ?? null} />
                </div>
              ) : null}
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}
