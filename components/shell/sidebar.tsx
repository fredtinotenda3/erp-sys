import Link from "next/link";

import type { VisibleNavItem } from "./nav-config";
import { NavList } from "./nav-list";

// Desktop/tablet sidebar. UX spec §11.1: icon-only at md, icon + label at lg;
// below md the MobileNav drawer in the top bar takes over. The item list is
// computed on the server from the user's capabilities and passed as plain data.
export function Sidebar({ items, orgName }: { items: VisibleNavItem[]; orgName: string }) {
  return (
    <aside className="hidden shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:block md:w-16 lg:w-60">
      <div className="sticky top-0 flex h-screen flex-col">
        <Link
          href="/dashboard"
          className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4 outline-none focus-visible:ring-2 focus-visible:ring-sidebar-marker"
          aria-label="Operis — Command Centre"
        >
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sm font-semibold">
            O
          </span>
          <span className="hidden min-w-0 lg:block">
            <span className="block text-sm font-semibold leading-tight">Operis</span>
            <span className="block truncate text-xs text-sidebar-muted">{orgName}</span>
          </span>
        </Link>
        <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
          <NavList items={items} compact />
        </nav>
      </div>
    </aside>
  );
}
