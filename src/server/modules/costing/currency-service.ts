// Read-only list of supported currency codes, so forms can offer a dropdown
// instead of a free-text field. `currency` is global reference data (not
// org-owned, no sensitive content), so any authenticated caller may read it (the route requires a session;
// the function itself takes no session because nothing in it is org-scoped).
// Mutations stay a seeding concern (scripts/seed-currencies.sql).
import { prisma } from "../../shared/db";

export interface CurrencyOption {
  code: string;
  name: string;
  decimals: number;
}

export async function listCurrencies(): Promise<CurrencyOption[]> {
  const rows = await prisma.currency.findMany({ orderBy: { code: "asc" } });
  return rows.map((r) => ({ code: r.code.trim(), name: r.name, decimals: r.decimals }));
}
