import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";

import { getItemById } from "../../../../../src/server/modules/catalog/item-service";
import { toItemView } from "../../../../../src/server/modules/catalog/item-view";
import { listBomVersions } from "../../../../../src/server/modules/catalog/bom-service";
import { listStockBalances } from "../../../../../src/server/modules/inventory/stock-service";
import { listInspectionPlans } from "../../../../../src/server/modules/production/quality-plan-service";
import { getPlasticsMaterialAttributes, getPlasticsProductSpec } from "../../../../../src/server/modules/catalog/plastics-item-service";
import { ActivateBomButton } from "../../../../../components/features/catalog/activate-bom-button";
import { EditItemDialog } from "../../../../../components/features/catalog/edit-item-dialog";
import { InspectionPlanForm } from "../../../../../components/features/production/inspection-plan-form";
import { AddCharacteristicForm } from "../../../../../components/features/production/characteristic-form";
import { PlasticsMaterialAttributesForm, PlasticsProductSpecForm } from "../../../../../components/features/catalog/plastics-spec-form";
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
import type { Bom, InspectionPlanView, Item, PlasticsMaterialAttributesView, PlasticsProductSpecView, StockBalance } from "../../../../../lib/api-types";

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
  const hasQuality = ctx.can("quality:read");
  // Milestone 6: visible for either side of the plastics vertical regardless
  // of the org's current industry profile (reads are never profile-gated --
  // switching profiles must never hide historical data), as long as the
  // role can at least read items. Writes on the tab itself are gated on
  // plastics_spec:manage + the plastics profile being active.
  const isPlasticsMaterial = item.itemType === "raw_material" || item.itemType === "consumable";
  const isPlasticsProduct = PRODUCIBLE.includes(item.itemType);
  const hasPlastics = isPlasticsMaterial || isPlasticsProduct;
  const sp = await searchParams;
  const tabParam = param(sp.tab);
  const tab =
    tabParam === "bom" && hasBom ? "bom" :
    tabParam === "quality" && hasQuality ? "quality" :
    tabParam === "plastics" && hasPlastics ? "plastics" :
    "overview";

  const tabs = [
    { key: "overview", label: "Overview", href: `/catalog/items/${id}` },
    ...(hasBom ? [{ key: "bom", label: "Bill of materials", href: `/catalog/items/${id}?tab=bom` }] : []),
    ...(hasQuality ? [{ key: "quality", label: "Inspection plans", href: `/catalog/items/${id}?tab=quality` }] : []),
    ...(hasPlastics ? [{ key: "plastics", label: "Plastics", href: `/catalog/items/${id}?tab=plastics` }] : []),
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
      {tab === "bom" ? (
        <BomTab ctx={ctx} item={item} />
      ) : tab === "quality" ? (
        <QualityPlanTab ctx={ctx} item={item} />
      ) : tab === "plastics" ? (
        <PlasticsTab ctx={ctx} item={item} isMaterial={isPlasticsMaterial} />
      ) : (
        <OverviewTab ctx={ctx} item={item} showCost={showCost} />
      )}
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
          <TH className="text-right">Expected scrap %</TH>
          <TH className="text-right">Expected yield %</TH>
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
              <TD className="text-right tabular-nums">{l.expectedScrapPct != null ? `${l.expectedScrapPct}%` : <span className="text-muted-foreground">—</span>}</TD>
              <TD className="text-right tabular-nums">{l.expectedYieldPct != null ? `${l.expectedYieldPct}%` : <span className="text-muted-foreground">—</span>}</TD>
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
            <span className="text-xs text-muted-foreground">
              Effective from {formatDate(active.effectiveFrom)}
              {active.effectiveTo ? ` to ${formatDate(active.effectiveTo)}` : ""}
            </span>
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

async function QualityPlanTab({ ctx, item }: { ctx: Awaited<ReturnType<typeof getPageContext>>; item: Item }) {
  const plans = await load<InspectionPlanView[]>(() => listInspectionPlans(ctx.session, item.id));
  if (!plans.ok) return <LoadFailure status={plans.status} message={plans.message} what="inspection plans" />;
  const canManage = ctx.can("quality_plan:manage");

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        What to check on this item, and the tolerances for each characteristic. Recording an inspection against a plan copies each characteristic&apos;s
        values at that moment, so editing a plan later never changes what a past measurement meant.
      </p>

      {plans.data.length === 0 ? (
        <Notice tone="warning" title="No inspection plan yet">
          Inspections can still be recorded without one -- a plan adds structured, tolerance-checked characteristics on top.
        </Notice>
      ) : (
        plans.data.map((plan) => (
          <Card key={plan.id}>
            <CardHeader>
              <CardTitle>
                {plan.name} {!plan.isActive ? <span className="ml-1 font-normal text-muted-foreground">· Inactive</span> : null}
              </CardTitle>
            </CardHeader>
            {plan.characteristics.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No characteristics yet.</p>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Characteristic</TH>
                    <TH>Unit</TH>
                    <TH className="text-right">Min</TH>
                    <TH className="text-right">Target</TH>
                    <TH className="text-right">Max</TH>
                    <TH>Status</TH>
                  </tr>
                </THead>
                <TBody>
                  {plan.characteristics.map((c) => (
                    <TR key={c.id}>
                      <TD className="font-medium">{c.name}</TD>
                      <TD>{c.uom ?? <span className="text-muted-foreground">—</span>}</TD>
                      <TD className="text-right tabular-nums">{c.minValue ?? <span className="text-muted-foreground">—</span>}</TD>
                      <TD className="text-right tabular-nums">{c.targetValue ?? <span className="text-muted-foreground">—</span>}</TD>
                      <TD className="text-right tabular-nums">{c.maxValue ?? <span className="text-muted-foreground">—</span>}</TD>
                      <TD><ActiveBadge active={c.isActive} /></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            {canManage ? (
              <div className="border-t border-border p-4">
                <AddCharacteristicForm planId={plan.id} />
              </div>
            ) : null}
          </Card>
        ))
      )}

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>New inspection plan</CardTitle>
          </CardHeader>
          <CardContent>
            <InspectionPlanForm itemId={item.id} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

async function PlasticsTab({ ctx, item, isMaterial }: { ctx: Awaited<ReturnType<typeof getPageContext>>; item: Item; isMaterial: boolean }) {
  const canManage = ctx.can("plastics_spec:manage");
  if (isMaterial) {
    const res = await load<PlasticsMaterialAttributesView | null>(() => getPlasticsMaterialAttributes(ctx.session, item.id));
    if (!res.ok) return <LoadFailure status={res.status} message={res.message} what="plastics material attributes" />;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Plastics material attributes</CardTitle>
        </CardHeader>
        <CardContent>
          {canManage && ctx.me.industryProfile !== "plastics" ? (
            <Notice tone="neutral" title="Not on the plastics profile">
              This organization&apos;s manufacturing profile isn&apos;t plastics, so these fields can&apos;t be changed right now. Existing values stay visible.
            </Notice>
          ) : null}
          <div className="mt-3">
            <PlasticsMaterialAttributesForm itemId={item.id} initial={res.data} canManage={canManage && ctx.me.industryProfile === "plastics"} />
          </div>
        </CardContent>
      </Card>
    );
  }
  const res = await load<PlasticsProductSpecView | null>(() => getPlasticsProductSpec(ctx.session, item.id));
  if (!res.ok) return <LoadFailure status={res.status} message={res.message} what="the plastics product spec" />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plastics product spec</CardTitle>
      </CardHeader>
      <CardContent>
        {canManage && ctx.me.industryProfile !== "plastics" ? (
          <Notice tone="neutral" title="Not on the plastics profile">
            This organization&apos;s manufacturing profile isn&apos;t plastics, so these fields can&apos;t be changed right now. Existing values stay visible.
          </Notice>
        ) : null}
        <div className="mt-3">
          <PlasticsProductSpecForm itemId={item.id} initial={res.data} canManage={canManage && ctx.me.industryProfile === "plastics"} />
        </div>
      </CardContent>
    </Card>
  );
}
