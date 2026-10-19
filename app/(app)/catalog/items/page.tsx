import Link from "next/link";
import { Plus } from "lucide-react";

import type { ItemType } from "../../../../lib/api-types";
import { ITEM_TYPE_LABELS, ITEM_TYPE_OPTIONS } from "../../../../lib/labels";
import { formatQuantity } from "../../../../lib/format";
import { getPageContext, param } from "../../../../lib/server/page-context";
import { loadItems } from "../../../../lib/server/lookups";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { Select } from "../../../../components/ui/select";
import { PageHeader } from "../../../../components/ui/page-header";
import { EmptyState, AccessDenied, ErrorState } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { ActiveBadge } from "../../../../components/ui/status-badge";
import { Money } from "../../../../components/ui/provenance";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";

export const metadata = { title: "Products & BOM · Operis" };

const TYPES = new Set<string>(ITEM_TYPE_OPTIONS.map(([k]) => k));

export default async function ItemsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("item:read")) return <AccessDenied what="the product catalog" />;

  const sp = await searchParams;
  const q = param(sp.q);
  const typeParam = param(sp.type);
  const type = typeParam && TYPES.has(typeParam) ? (typeParam as ItemType) : undefined;
  const status = param(sp.status) ?? "active";

  const items = await loadItems(ctx, {
    search: q,
    itemType: type,
    isActive: status === "all" ? undefined : status === "inactive" ? false : true,
  });
  const showCost = ctx.can("cost:read");
  const filtered = Boolean(q || type || status !== "active");

  return (
    <>
      <PageHeader
        title="Products & BOM"
        description="Finished goods, materials and spare parts. Open a finished good to see and version its bill of materials."
        actions={
          ctx.can("item:create") ? (
            <Link href="/catalog/items/new" className={buttonVariants()}>
              <Plus /> New item
            </Link>
          ) : null
        }
      />

      <FilterBar resetHref="/catalog/items">
        <FilterField id="q" label="Search name or SKU" className="min-w-52 flex-1">
          <Input id="q" name="q" type="search" defaultValue={q ?? ""} placeholder="e.g. bearing or TLS-3002" />
        </FilterField>
        <FilterField id="type" label="Type">
          <Select id="type" name="type" defaultValue={type ?? ""}>
            <option value="">All types</option>
            {ITEM_TYPE_OPTIONS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </Select>
        </FilterField>
      </FilterBar>

      {!items.available ? (
        <ErrorState message="The item list couldn't be loaded. Try again in a moment." />
      ) : items.list.length === 0 ? (
        <EmptyState
          title={filtered ? "No items match these filters" : "No items yet"}
          action={
            !filtered && ctx.can("item:create") ? (
              <Link href="/catalog/items/new" className={buttonVariants()}>
                Create the first item
              </Link>
            ) : null
          }
        >
          {filtered ? "Try a different search or clear the filters." : "Items are the products, materials and parts your jobs and stock refer to."}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>SKU</TH>
                <TH>Name</TH>
                <TH>Type</TH>
                <TH>UoM</TH>
                <TH className="text-right">Reorder level</TH>
                {showCost ? <TH className="text-right">Standard cost</TH> : null}
                {showCost ? <TH className="text-right">Selling price</TH> : null}
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {items.list.map((i) => (
                <TR key={i.id}>
                  <TD className="whitespace-nowrap font-mono text-xs">{i.sku}</TD>
                  <TD>
                    <Link href={`/catalog/items/${i.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                      {i.name}
                    </Link>
                  </TD>
                  <TD>{ITEM_TYPE_LABELS[i.itemType]}</TD>
                  <TD>{i.uom}</TD>
                  <TD className="text-right">{i.reorderThreshold ? formatQuantity(i.reorderThreshold) : <span className="text-muted-foreground">Not set</span>}</TD>
                  {showCost ? (
                    <TD className="text-right">
                      <Money amount={i.standardCost} currency={i.standardCostCurrency} unavailableReason="no standard cost" />
                    </TD>
                  ) : null}
                  {showCost ? (
                    <TD className="text-right">{i.isSellable ? <Money amount={i.sellingPrice} currency={i.sellingPriceCurrency} /> : <span className="text-muted-foreground">Not sold</span>}</TD>
                  ) : null}
                  <TD>
                    <ActiveBadge active={i.isActive} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {items.list.length} item{items.list.length === 1 ? "" : "s"}
            {showCost ? "" : " · Cost and price columns are shown to roles with cost access."}
          </p>
        </Card>
      )}
    </>
  );
}
