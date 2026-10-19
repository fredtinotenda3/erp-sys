// Capability-driven response projection for catalog items, in the same spirit
// as production/job-view.ts and inventory/stock-core.ts's toMovementView.
//
// Why this exists: item-service returns raw rows, so `standardCost` and
// `sellingPrice` (and their currencies) reached every role holding item:read --
// including INVENTORY_MANAGER and VIEWER, who do NOT hold cost:read. Pricing is
// margin-sensitive (job-view.ts treats the quoted amount the same way), so the
// fields are removed here unless the caller may read cost. Pure function: no I/O.
import { hasCapability, type Role } from "../../shared/authz";

const COST_FIELDS = ["standardCost", "standardCostCurrency", "sellingPrice", "sellingPriceCurrency"] as const;

export function toItemView<T extends object>(role: Role, item: T): T {
  if (hasCapability(role, "cost:read")) return item;
  const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  for (const key of COST_FIELDS) delete copy[key];
  return copy as T;
}

export function toItemViews<T extends object>(role: Role, items: readonly T[]): T[] {
  return items.map((i) => toItemView(role, i));
}
