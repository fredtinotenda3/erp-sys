// Navigation config — the frontend half of UX_UI_ARCHITECTURE.md §1.1/§1.6.
//
// Capability presence is the ONLY visibility rule ("adding a capability in
// authz.ts is the only change needed to surface a nav item"). Hiding an item is
// a usability measure; every page and service re-checks authorization on the
// server regardless.
//
// `implemented` is a temporary second gate: modules whose screens don't exist
// yet (Orders, Customers, Quality, Reports, Settings) stay out of the sidebar
// rather than linking to a page that isn't there. Flip it per module as each
// screen ships; once everything has shipped, delete the field.
import { hasCapability, type Capability, type Role } from "../../src/server/shared/authz";

export type NavIcon = "currency" | "dashboard" | "production" | "inventory" | "catalog" | "orders" | "customers" | "suppliers" | "purchasing" | "quality" | "reports" | "settings";

export interface NavChild {
  label: string;
  href: string;
  capabilities: Capability[];
}

export interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
  /** Empty = every authenticated role. Otherwise ANY listed capability unlocks the item. */
  capabilities: Capability[];
  implemented: boolean;
  children?: NavChild[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Command Centre", href: "/dashboard", icon: "dashboard", capabilities: [], implemented: true },
  { label: "Shop floor", href: "/shop-floor", icon: "production", capabilities: ["output:record", "stage:transition"], implemented: true },
  {
    label: "Orders",
    href: "/orders",
    icon: "orders",
    // Widened to include dispatch:read (Milestone 3) so a role that holds
    // only that capability (none currently do -- INVENTORY_MANAGER, the
    // role that creates dispatches, was also given sales_order:read -- see
    // authz.ts's comment on that grant) still sees this parent item and
    // can reach "Dispatches". Same defensive widening Reports' own parent
    // item already applies for finished_goods:read.
    capabilities: ["sales_order:read", "dispatch:read"],
    implemented: true,
    children: [
      { label: "Orders", href: "/orders", capabilities: ["sales_order:read"] },
      { label: "Dispatches", href: "/dispatches", capabilities: ["dispatch:read"] },
    ],
  },
  {
    label: "Production",
    href: "/production/jobs",
    icon: "production",
    // Widened to include machine:read (Milestone 4) and mould:read
    // (Milestone 6) so a role holding only one of those capabilities still
    // sees this parent item and can reach "Machines"/"Capacity"/"Moulds" --
    // same defensive widening pattern as Orders' and Reports' own parent
    // items.
    capabilities: ["production_job:read", "machine:read", "mould:read"],
    implemented: true,
    children: [
      { label: "Jobs", href: "/production/jobs", capabilities: ["production_job:read"] },
      { label: "New job", href: "/production/jobs/new", capabilities: ["production_job:create"] },
      { label: "Machines", href: "/production/machines", capabilities: ["machine:read"] },
      { label: "Capacity", href: "/production/capacity", capabilities: ["machine:read"] },
      // Milestone 6. Visible under every profile (mould:read is granted
      // independently of the org's industry profile -- see authz.ts), but
      // the page itself is only meaningful once the org is on the plastics
      // profile; the list page says so when it's empty for any other reason.
      { label: "Moulds", href: "/production/moulds", capabilities: ["mould:read"] },
    ],
  },
  {
    label: "Inventory",
    href: "/inventory/stock",
    icon: "inventory",
    capabilities: ["stock:read"],
    implemented: true,
    children: [
      { label: "Stock", href: "/inventory/stock", capabilities: ["stock:read"] },
      { label: "Movements", href: "/inventory/movements", capabilities: ["stock:read"] },
      { label: "Warehouses", href: "/inventory/warehouses", capabilities: ["stock:read"] },
      { label: "Receive stock", href: "/inventory/receive", capabilities: ["stock:receive"] },
      { label: "Adjust stock", href: "/inventory/adjust", capabilities: ["stock:adjust"] },
      { label: "Issue to job", href: "/inventory/issue", capabilities: ["material:issue"] },
      { label: "Return from job", href: "/inventory/return", capabilities: ["material:issue"] },
      { label: "Material lots", href: "/inventory/lots", capabilities: ["lot:read"] },
      { label: "Finished goods", href: "/inventory/finished-goods", capabilities: ["finished_goods:read"] },
    ],
  },
  {
    label: "Products & BOM",
    href: "/catalog/items",
    icon: "catalog",
    capabilities: ["item:read", "bom:read"],
    implemented: true,
    children: [
      { label: "All items", href: "/catalog/items", capabilities: ["item:read"] },
      { label: "New item", href: "/catalog/items/new", capabilities: ["item:create"] },
    ],
  },
  { label: "Exchange rates", href: "/costing/exchange-rates", icon: "currency", capabilities: ["exchange_rate:read"], implemented: true },
  { label: "Customers", href: "/customers", icon: "customers", capabilities: ["customer:read"], implemented: true },
  { label: "Suppliers", href: "/suppliers", icon: "suppliers", capabilities: ["supplier:read"], implemented: true },
  {
    label: "Purchasing",
    href: "/purchasing/orders",
    icon: "purchasing",
    capabilities: ["purchase_order:read", "goods_receipt:read"],
    implemented: true,
    children: [
      { label: "Purchase orders", href: "/purchasing/orders", capabilities: ["purchase_order:read"] },
      { label: "New purchase order", href: "/purchasing/orders/new", capabilities: ["purchase_order:create"] },
    ],
  },
  {
    label: "Quality",
    href: "/quality",
    icon: "quality",
    capabilities: ["quality:read"],
    implemented: true,
    children: [
      { label: "Overview", href: "/quality", capabilities: ["quality:read"] },
      { label: "Inspections", href: "/quality/inspections", capabilities: ["quality:read"] },
    ],
  },
  {
    label: "Reports",
    href: "/reports",
    icon: "reports",
    capabilities: ["cost:read", "finished_goods:read"],
    implemented: true,
    children: [
      { label: "Job costs", href: "/reports/job-costs", capabilities: ["cost:read"] },
      { label: "Profitability", href: "/reports/profitability", capabilities: ["cost:read"] },
      { label: "WIP valuation", href: "/reports/wip-valuation", capabilities: ["cost:read"] },
      { label: "Finished-goods valuation", href: "/reports/fg-valuation", capabilities: ["finished_goods:read"] },
    ],
  },
  {
    label: "Settings",
    href: "/settings/users",
    icon: "settings",
    // Widened to include industry_profile:manage (Milestone 5) so a role
    // holding only that capability still sees this parent item -- same
    // defensive widening pattern used throughout this file. In practice
    // this changes nothing today: industry_profile:manage is OWNER_ADMIN-
    // only, and OWNER_ADMIN already holds user:read.
    capabilities: ["user:read", "audit_log:read", "industry_profile:manage"],
    implemented: true,
    children: [
      { label: "Users", href: "/settings/users", capabilities: ["user:read"] },
      { label: "Branches", href: "/settings/branches", capabilities: ["user:read"] },
      { label: "Audit log", href: "/settings/audit-log", capabilities: ["audit_log:read"] },
      { label: "Manufacturing profile", href: "/settings/industry-profile", capabilities: ["industry_profile:manage"] },
    ],
  },
] as const;

export interface VisibleNavItem {
  label: string;
  href: string;
  icon: NavIcon;
  children: { label: string; href: string }[];
}

/** Serializable (plain data) so the client Sidebar can receive it from the server layout. */
export function getVisibleNavItems(role: Role): VisibleNavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.implemented && (item.capabilities.length === 0 || item.capabilities.some((c) => hasCapability(role, c))),
  ).map((item) => ({
    label: item.label,
    href: item.href,
    icon: item.icon,
    children: (item.children ?? [])
      .filter((c) => c.capabilities.length === 0 || c.capabilities.some((cap) => hasCapability(role, cap)))
      .map((c) => ({ label: c.label, href: c.href })),
  }));
}
