"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, ChartColumn, Coins, ClipboardCheck, Factory, LayoutDashboard, Package, Settings, ShoppingCart, Users, type LucideIcon } from "lucide-react";

import type { NavIcon, VisibleNavItem } from "./nav-config";
import { cn } from "@/lib/utils";

const ICONS: Record<NavIcon, LucideIcon> = {
  currency: Coins,
  dashboard: LayoutDashboard,
  production: Factory,
  inventory: Boxes,
  catalog: Package,
  orders: ShoppingCart,
  customers: Users,
  quality: ClipboardCheck,
  reports: ChartColumn,
  settings: Settings,
};

function sectionActive(pathname: string, item: VisibleNavItem): boolean {
  if (item.href === "/dashboard") return pathname === "/dashboard";
  const roots = new Set([item.href.split("/").slice(0, 2).join("/")]);
  for (const c of item.children) roots.add(c.href.split("/").slice(0, 2).join("/"));
  return [...roots].some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

/** Longest-matching child wins, so "/production/jobs/new" doesn't also light up "Jobs". */
function activeChildHref(pathname: string, item: VisibleNavItem): string | null {
  let best: string | null = null;
  for (const c of item.children) {
    if ((pathname === c.href || pathname.startsWith(`${c.href}/`)) && (!best || c.href.length > best.length)) best = c.href;
  }
  return best;
}

export function NavList({ items, compact = false, onNavigate }: { items: VisibleNavItem[]; compact?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = sectionActive(pathname, item);
        const activeChild = active ? activeChildHref(pathname, item) : null;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              title={item.label}
              onClick={onNavigate}
              aria-current={active && item.children.length === 0 ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-marker",
                compact && "justify-center px-2 lg:justify-start lg:px-3",
                active ? "bg-sidebar-accent font-medium text-sidebar-foreground" : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              {active ? <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-marker" /> : null}
              <Icon className="size-4.5 shrink-0" aria-hidden="true" />
              <span className={cn(compact && "hidden lg:inline")}>{item.label}</span>
            </Link>
            {active && item.children.length > 1 ? (
              <ul className={cn("mt-0.5 mb-1 ml-5 flex flex-col gap-0.5 border-l border-sidebar-border pl-3", compact && "hidden lg:flex")}>
                {item.children.map((c) => {
                  const isActive = c.href === activeChild;
                  return (
                    <li key={c.href}>
                      <Link
                        href={c.href}
                        onClick={onNavigate}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "block rounded-md px-2 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-sidebar-marker",
                          isActive ? "font-medium text-sidebar-foreground" : "text-sidebar-muted hover:text-sidebar-foreground",
                        )}
                      >
                        {c.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
