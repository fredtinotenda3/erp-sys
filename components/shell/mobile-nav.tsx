"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

import type { VisibleNavItem } from "./nav-config";
import { NavList } from "./nav-list";
import { Button } from "../ui/button";

// Below md the sidebar becomes a slide-over drawer. The inner component is
// keyed by pathname, so navigating anywhere remounts it closed -- no effect
// that sets state, and the drawer can never stay open over the new page.
export function MobileNav({ items, orgName }: { items: VisibleNavItem[]; orgName: string }) {
  const pathname = usePathname();
  return <MobileNavInner key={pathname} items={items} orgName={orgName} />;
}

function MobileNavInner({ items, orgName }: { items: VisibleNavItem[]; orgName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <Button type="button" variant="ghost" size="icon" aria-label="Open navigation menu" aria-expanded={open} onClick={() => setOpen(true)}>
        <Menu />
      </Button>
      {open ? (
        <div
          className="fixed inset-0 z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <button type="button" aria-label="Close navigation menu" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground shadow-xl">
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4">
              <div>
                <p className="text-sm font-semibold leading-tight">Operis</p>
                <p className="text-xs text-sidebar-muted">{orgName}</p>
              </div>
              <Button type="button" variant="ghost" size="icon" className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground" aria-label="Close navigation menu" autoFocus onClick={() => setOpen(false)}>
                <X />
              </Button>
            </div>
            <nav aria-label="Primary" className="flex-1 overflow-y-auto p-2">
              <NavList items={items} onNavigate={() => setOpen(false)} />
            </nav>
          </div>
        </div>
      ) : null}
    </div>
  );
}
