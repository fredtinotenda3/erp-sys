import { notFound } from "next/navigation";

import { getItemById } from "../../../../../../../src/server/modules/catalog/item-service";
import { listBomVersions } from "../../../../../../../src/server/modules/catalog/bom-service";
import { PageHeader } from "../../../../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../../../../components/ui/states";
import { Notice } from "../../../../../../../components/ui/notice";
import { BomEditor } from "../../../../../../../components/features/catalog/bom-editor";
import { PRODUCIBLE } from "../../../../../../../lib/labels";
import { getPageContext, load, UUID_RE } from "../../../../../../../lib/server/page-context";
import { loadItems } from "../../../../../../../lib/server/lookups";
import type { Bom, Item } from "../../../../../../../lib/api-types";

export const metadata = { title: "New BOM version · Operis" };

export default async function NewBomPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("bom:create") || !ctx.can("item:read")) return <AccessDenied what="BOM creation" />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const item = await load<Item>(() => getItemById(ctx.session, id));
  if (!item.ok) {
    if (item.status === 404) notFound();
    return <LoadFailure status={item.status} message={item.message} what="this item" />;
  }
  const product = item.data;
  const crumbs = [{ label: "Products & BOM", href: "/catalog/items" }, { label: product.name, href: `/catalog/items/${id}?tab=bom` }, { label: "New BOM version" }];

  if (!PRODUCIBLE.includes(product.itemType)) {
    return (
      <>
        <PageHeader title="New BOM version" crumbs={crumbs} />
        <Notice tone="warning">Only finished goods and work-in-progress items are produced, so only they have a bill of materials.</Notice>
      </>
    );
  }

  const [versions, materials] = await Promise.all([load<Bom[]>(() => listBomVersions(ctx.session, id)), loadItems(ctx, { isActive: true })]);
  if (!versions.ok) return <LoadFailure status={versions.status} message={versions.message} what="BOM versions" />;
  if (!materials.available) return <LoadFailure status={500} message="The material list couldn't be loaded." what="materials" />;

  const active = versions.data.find((v) => v.status === "active") ?? null;
  const latest = versions.data.reduce((max, v) => Math.max(max, v.version), 0);

  return (
    <>
      <PageHeader title={`New BOM version for ${product.name}`} crumbs={crumbs} description="List the materials needed to make one unit." />
      <BomEditor
        productId={id}
        seedLines={(active?.lines ?? []).map((l) => ({ materialItemId: l.materialItemId, quantity: l.quantity, uom: l.uom }))}
        materials={materials.list.filter((m) => m.id !== id).map((m) => ({ id: m.id, name: m.name, sku: m.sku, uom: m.uom }))}
        nextVersion={latest + 1}
        activeVersion={active?.version ?? null}
      />
    </>
  );
}
