// Catalog item CRUD-lite. "Item" is the unified product/material entity
// (ARCHITECTURE.md §3.1/§3.2) — a raw material, consumable, spare part, WIP
// unit, or finished (sellable) good are all rows in this one table,
// distinguished by `itemType`. No hard delete, same reasoning as
// branch-service.ts/user-service.ts: once an item has any audit history (it
// does, immediately — see below) or is referenced by a BOM line, stock
// movement, or order line, deleting the row would either violate a foreign
// key or silently orphan history. `isActive` (soft delete) is the only
// lifecycle transition exposed.
import { z } from "zod";
import { prisma, isUniqueConstraintError } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

// Redeclared as a plain string-literal union, not imported from the
// generated Prisma client — same reasoning as shared/authz.ts's ROLE_VALUES
// header comment (this sandbox could not run `prisma generate` to confirm
// the generated enum's exact export shape; confirm these 5 values still
// match prisma/schema.prisma's `enum ItemType` on your machine before
// relying on this list elsewhere).
export const ITEM_TYPE_VALUES = ["raw_material", "consumable", "spare_part", "finished_good", "wip"] as const;
export type ItemType = (typeof ITEM_TYPE_VALUES)[number];

async function assertKnownCurrency(code: string): Promise<void> {
  const currency = await prisma.currency.findUnique({ where: { code } });
  if (!currency) {
    throw new ValidationError(`Unknown currency code "${code}" — seed it into the currency table first.`);
  }
}

// Shared pairing rule for every (amount, currencyCode) field pair on Item:
// both present or both absent — never an amount with no currency attached,
// and never a currency code with nothing denominated in it. Applied to
// sellingPrice/sellingPriceCurrency and standardCost/standardCostCurrency.
function addPairRefinement(
  amountKey: "sellingPrice" | "standardCost",
  currencyKey: "sellingPriceCurrency" | "standardCostCurrency",
) {
  return (data: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const amount = data[amountKey];
    const currency = data[currencyKey];
    if ((amount === undefined) !== (currency === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: `${amountKey} and ${currencyKey} must be provided together, or not at all`,
        path: [amount === undefined ? currencyKey : amountKey],
      });
    }
  };
}

// NOTE: isSellable has no `.default()` here deliberately — a default would
// be correct for create (omitted -> false) but wrong for update (omitted
// must mean "leave unchanged", not "set to false"). createItemSchema below
// applies `.default(false)` on its own copy of the field; updateItemSchema
// leaves it a bare optional boolean and treats "absent" as "no change" in
// updateItem()'s logic.
const baseItemFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  uom: z.string().trim().min(1).max(20),
  sellingPrice: z.number().finite().positive().optional(),
  sellingPriceCurrency: z.string().trim().toUpperCase().length(3).optional(),
  standardCost: z.number().finite().nonnegative().optional(),
  standardCostCurrency: z.string().trim().toUpperCase().length(3).optional(),
};

// itemType and sku are create-only — see updateItemSchema's header comment
// for why they are deliberately not part of the update path.
const createItemSchema = z
  .object({
    sku: z.string().trim().min(1).max(64),
    itemType: z.enum(ITEM_TYPE_VALUES),
    isSellable: z.boolean().default(false),
    ...baseItemFields,
  })
  .superRefine((data, ctx) => {
    addPairRefinement("sellingPrice", "sellingPriceCurrency")(data, ctx);
    addPairRefinement("standardCost", "standardCostCurrency")(data, ctx);
    // ARCHITECTURE.md §3.1: selling price fields are "nullable and only
    // populated for sellable types" — enforced as a hard rule here, not
    // left to the caller's discretion, so isSellable can never silently
    // disagree with whether a price is actually set.
    if (data.isSellable && data.sellingPrice === undefined) {
      ctx.addIssue({ code: "custom", message: "isSellable:true requires sellingPrice and sellingPriceCurrency", path: ["sellingPrice"] });
    }
    if (!data.isSellable && data.sellingPrice !== undefined) {
      ctx.addIssue({ code: "custom", message: "sellingPrice can only be set when isSellable is true", path: ["sellingPrice"] });
    }
  });

export async function createItem(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "item:create");
  const parsed = createItemSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid item payload", parsed.error.issues);
  const data = parsed.data;

  const currencyChecks: Promise<void>[] = [];
  if (data.sellingPriceCurrency) currencyChecks.push(assertKnownCurrency(data.sellingPriceCurrency));
  if (data.standardCostCurrency && data.standardCostCurrency !== data.sellingPriceCurrency) {
    currencyChecks.push(assertKnownCurrency(data.standardCostCurrency));
  }
  await Promise.all(currencyChecks);

  try {
    const item = await prisma.item.create({
      data: {
        orgId: session.orgId,
        sku: data.sku,
        name: data.name,
        description: data.description ?? null,
        uom: data.uom,
        itemType: data.itemType,
        isSellable: data.isSellable,
        sellingPrice: data.sellingPrice ?? null,
        sellingPriceCurrency: data.sellingPriceCurrency ?? null,
        standardCost: data.standardCost ?? null,
        standardCostCurrency: data.standardCostCurrency ?? null,
      },
    });
    await recordAudit(prisma, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "item",
      entityId: item.id,
      action: "create",
      afterValue: { sku: item.sku, name: item.name, itemType: item.itemType },
    });
    return item;
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(`An item with SKU "${data.sku}" already exists in this organization`);
    }
    throw err;
  }
}

export interface ListItemsFilter {
  itemType?: ItemType;
  isActive?: boolean;
  search?: string;
}

export async function listItems(session: AuthenticatedSession, filter: ListItemsFilter = {}) {
  assertCapability(session.role, "item:read");
  return prisma.item.findMany({
    where: {
      orgId: session.orgId,
      ...(filter.itemType ? { itemType: filter.itemType } : {}),
      ...(filter.isActive !== undefined ? { isActive: filter.isActive } : {}),
      ...(filter.search
        ? {
            OR: [
              { sku: { contains: filter.search, mode: "insensitive" as const } },
              { name: { contains: filter.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
  });
}

export async function getItemById(session: AuthenticatedSession, itemId: string) {
  assertCapability(session.role, "item:read");
  const item = await prisma.item.findFirst({ where: { orgId: session.orgId, id: itemId } });
  if (!item) throw new NotFoundError("Item");
  return item;
}

// sku and itemType are NOT updatable here. sku is a display/lookup key, not
// a reason on its own to forbid renaming, but a BOM-material/stock-movement
// history keyed by item.id doesn't care about sku text — the real reason
// it's excluded is that there's no product requirement to change it yet,
// and adding the endpoint surface now (uniqueness-conflict handling,
// cross-checking it's not mid-edit on the BOM screen) is speculative scope.
// itemType is excluded on purpose: it decides which fields are even
// meaningful (selling fields only for sellable types — see the create-path
// refinement above), and once material/stock/BOM history exists against an
// item, changing its fundamental classification underneath that history is
// a materially different, higher-risk operation than renaming it. Flag if
// you want either reopened — this is a default, not a spec answer.
const updateItemSchema = z
  .object({
    ...baseItemFields,
    isSellable: z.boolean(), // no default — see baseItemFields' header comment
    isActive: z.boolean(),
  })
  .partial()
  .superRefine((data, ctx) => {
    addPairRefinement("sellingPrice", "sellingPriceCurrency")(data, ctx);
    addPairRefinement("standardCost", "standardCostCurrency")(data, ctx);
  });

export async function updateItem(session: AuthenticatedSession, itemId: string, input: unknown) {
  assertCapability(session.role, "item:update");
  const parsed = updateItemSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid item payload", parsed.error.issues);
  const data = parsed.data;

  const existing = await prisma.item.findFirst({ where: { orgId: session.orgId, id: itemId } });
  if (!existing) throw new NotFoundError("Item");

  // The update schema's sellingPrice field has no way to carry an explicit
  // "set to null" (it's a plain positive number, same type as the create
  // path, to keep one pairing rule instead of two) — so turning isSellable
  // off is the ONE signal that means "also clear the price fields," and the
  // service does that itself rather than requiring the caller to guess at
  // a null-sentinel the schema doesn't document.
  const clearingSellingPrice = data.isSellable === false && existing.isSellable === true;
  const settingSellingPrice = data.sellingPrice !== undefined;

  if (clearingSellingPrice && settingSellingPrice) {
    throw new ValidationError("Cannot set sellingPrice in the same call that turns isSellable off");
  }

  const resultingIsSellable = data.isSellable ?? existing.isSellable;
  const resultingSellingPrice = clearingSellingPrice
    ? null
    : settingSellingPrice
      ? data.sellingPrice!
      : existing.sellingPrice;
  if (resultingIsSellable && resultingSellingPrice === null) {
    throw new ValidationError("isSellable:true requires sellingPrice and sellingPriceCurrency to be set");
  }

  const currencyChecks: Promise<void>[] = [];
  if (data.sellingPriceCurrency) currencyChecks.push(assertKnownCurrency(data.sellingPriceCurrency));
  if (data.standardCostCurrency) currencyChecks.push(assertKnownCurrency(data.standardCostCurrency));
  await Promise.all(currencyChecks);

  const updateData: Record<string, unknown> = { ...data };
  if (clearingSellingPrice) {
    updateData.sellingPrice = null;
    updateData.sellingPriceCurrency = null;
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(updateData)) {
    before[key] = (existing as Record<string, unknown>)[key];
    after[key] = updateData[key];
  }

  const updated = await prisma.item.update({ where: { id: existing.id }, data: updateData });
  if (Object.keys(after).length > 0) {
    await recordAudit(prisma, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "item",
      entityId: existing.id,
      action: "update",
      beforeValue: before,
      afterValue: after,
    });
  }
  return updated;
}
