import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied } from "../../../../../components/ui/states";
import { ItemForm } from "../../../../../components/features/catalog/item-form";
import { getPageContext } from "../../../../../lib/server/page-context";
import { loadCurrencies } from "../../../../../lib/server/lookups";

export const metadata = { title: "New item · Operis" };

export default async function NewItemPage() {
  const ctx = await getPageContext();
  if (!ctx.can("item:create")) return <AccessDenied what="item creation" />;
  const canSeeCost = ctx.can("cost:read");
  const currencies = canSeeCost ? await loadCurrencies() : [];

  return (
    <>
      <PageHeader title="New item" crumbs={[{ label: "Products & BOM", href: "/catalog/items" }, { label: "New item" }]} />
      <ItemForm currencies={currencies} canSeeCost={canSeeCost} />
    </>
  );
}
