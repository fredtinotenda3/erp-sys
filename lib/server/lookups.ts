// Reference-data lookups shared by pages. Each one calls an existing service
// (so capability + org scope are enforced) and degrades to an empty map when
// the caller lacks access, with an `available` flag so pages can say "name
// unavailable" instead of silently showing blanks or ids as if they were names.
import { listItems } from "../../src/server/modules/catalog/item-service";
import { toItemViews } from "../../src/server/modules/catalog/item-view";
import { listUsers } from "../../src/server/modules/iam/user-service";
import { listCustomers } from "../../src/server/modules/customers/customer-service";
import { listWarehouses } from "../../src/server/modules/inventory/warehouse-service";
import { listCurrencies } from "../../src/server/modules/costing/currency-service";
import type { Currency, Customer, Item, UserLite, Warehouse } from "../api-types";
import { load, type PageContext } from "./page-context";

export interface Lookup<T> {
  list: T[];
  byId: Map<string, T>;
  available: boolean;
}

function toLookup<T extends { id: string }>(list: T[] | null): Lookup<T> {
  const l = list ?? [];
  return { list: l, byId: new Map(l.map((x) => [x.id, x])), available: list !== null };
}

/** Items with cost fields already removed for roles without cost:read (item-view.ts). */
export async function loadItems(ctx: PageContext, filter: Parameters<typeof listItems>[1] = {}): Promise<Lookup<Item>> {
  if (!ctx.can("item:read")) return toLookup<Item>(null);
  const r = await load<Item[]>(async () => toItemViews(ctx.session.role, await listItems(ctx.session, filter)));
  return toLookup(r.ok ? r.data : null);
}

export async function loadUsers(ctx: PageContext): Promise<Lookup<UserLite>> {
  if (!ctx.can("user:read")) return toLookup<UserLite>(null);
  const r = await load<UserLite[]>(async () => (await listUsers(ctx.session)).map((u) => ({ id: u.id, fullName: u.fullName })));
  return toLookup(r.ok ? r.data : null);
}

export async function loadCustomers(ctx: PageContext): Promise<Lookup<Customer>> {
  if (!ctx.can("customer:read")) return toLookup<Customer>(null);
  const r = await load<Customer[]>(async () => {
    const rows = await listCustomers(ctx.session);
    return rows.map((c) => ({ id: c.id, name: c.name, status: c.status }));
  });
  return toLookup(r.ok ? r.data : null);
}

export async function loadWarehouses(ctx: PageContext): Promise<Lookup<Warehouse>> {
  if (!ctx.can("stock:read")) return toLookup<Warehouse>(null);
  const r = await load<Warehouse[]>(() => listWarehouses(ctx.session));
  return toLookup(r.ok ? r.data : null);
}

export async function loadCurrencies(): Promise<Currency[]> {
  const r = await load<Currency[]>(() => listCurrencies());
  return r.ok ? r.data : [];
}

export function itemLabel(item: Pick<Item, "name" | "sku"> | undefined, fallbackId?: string): string {
  if (item) return `${item.name} (${item.sku})`;
  return fallbackId ? `Item ${fallbackId.slice(0, 8)}` : "Unknown item";
}
