// Sidebar nav config — the frontend half of UX_UI_ARCHITECTURE.md §1.1/§1.6.
//
// §1.6 is explicit: "the nav component renders an item only if the
// signed-in user holds at least one capability that item's module
// exposes... adding a capability in authz.ts is the only change needed to
// surface a new nav item for a role; no second source of truth in the
// frontend." This file is that one source of truth on the frontend side —
// it maps each §1.1 module to the capabilities that unlock it, nothing
// more.
//
// `implemented` is a TEMPORARY second gate on top of that, not part of the
// spec: most modules in §1.1's tree (Orders, Production, Inventory,
// Catalog, Customers, Quality, Reports, Settings) don't have a UI screen
// built yet, even though some of their backing capabilities already exist
// in authz.ts (e.g. every role with `item:read` already "has" Catalog
// access by the capability rule alone). Showing a nav link to a page that
// doesn't exist would be worse than not showing it, and the brief's own
// rule — "implement only the screens that have real backend data" —
// extends naturally to "don't link to a screen that doesn't exist yet
// either, backend or no backend." As each module's actual page ships, flip
// its `implemented` to true; nothing else about this file should need to
// change. Once every module has shipped, delete the `implemented` field
// entirely and this file becomes exactly what §1.6 describes: capability
// presence as the only gate.
import { hasCapability, type Capability, type Role } from "../../src/server/shared/authz";

export interface NavItem {
  label: string;
  href: string;
  /** Empty array = shown to every authenticated role (Command Centre, per §1.6's table — every role row includes it). */
  capabilities: Capability[];
  implemented: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Command Centre", href: "/dashboard", capabilities: [], implemented: true },
  { label: "Orders", href: "/orders", capabilities: ["sales_order:read"], implemented: false },
  { label: "Production", href: "/production/jobs", capabilities: ["production_job:read"], implemented: false },
  { label: "Inventory", href: "/inventory/stock", capabilities: ["stock:read"], implemented: false },
  { label: "Catalog", href: "/catalog/items", capabilities: ["item:read", "bom:read"], implemented: false },
  { label: "Customers", href: "/customers", capabilities: ["customer:read"], implemented: false },
  // Gated on quality:read (added to authz.ts alongside quality:record).
  { label: "Quality", href: "/quality", capabilities: ["quality:read"], implemented: false },
  { label: "Reports", href: "/reports/profitability", capabilities: ["cost:read"], implemented: false },
  { label: "Settings — Users", href: "/settings/users", capabilities: ["user:read"], implemented: false },
  { label: "Settings — Branches", href: "/settings/branches", capabilities: ["branch:read"], implemented: false },
  { label: "Settings — Audit Log", href: "/settings/audit-log", capabilities: ["audit_log:read"], implemented: false },
] as const;

export function getVisibleNavItems(role: Role): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.implemented && (item.capabilities.length === 0 || item.capabilities.some((c) => hasCapability(role, c))),
  );
}
