"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Avatar, AvatarFallback } from "../ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { BranchSwitcher } from "./branch-switcher";
import { MobileNav } from "./mobile-nav";
import type { VisibleNavItem } from "./nav-config";

export interface TopBarProps {
  fullName: string;
  email: string;
  orgName: string;
  roleLabel: string;
  branches: { id: string; name: string }[];
  selectedBranchId: string | null;
  navItems: VisibleNavItem[];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

// Fixed-height top bar (UX spec §12.2): mobile menu, organization, branch
// context, user menu. Breadcrumbs and primary actions live in each page's
// PageHeader so they can use real record names. Global ⌘K search is deferred
// (§16.4) and deliberately not rendered as a dead input.
export function TopBar({ fullName, email, orgName, roleLabel, branches, selectedBranchId, navItems }: TopBarProps) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <MobileNav items={navItems} orgName={orgName} />
        <span className="truncate text-sm font-medium">{orgName}</span>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <BranchSwitcher branches={branches} selectedId={selectedBranchId} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center gap-2 rounded-md p-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Account menu for ${fullName}`}
            >
              <Avatar>
                <AvatarFallback>{initials(fullName)}</AvatarFallback>
              </Avatar>
              <span className="hidden text-left leading-tight lg:block">
                <span className="block text-sm font-medium">{fullName}</span>
                <span className="block text-xs text-muted-foreground">{roleLabel}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="font-medium">{fullName}</span>
                <span className="text-xs text-muted-foreground">{email}</span>
                <span className="text-xs text-muted-foreground">
                  {roleLabel} · {orgName}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={loggingOut} onSelect={handleLogout}>
              {loggingOut ? "Logging out…" : "Log out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
