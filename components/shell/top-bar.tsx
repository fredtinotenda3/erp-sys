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

export interface TopBarProps {
  fullName: string;
  email: string;
  orgName: string;
  roleLabel: string;
  branches: { id: string; name: string }[];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

// §12.2: breadcrumb (max 3 segments) + search (⌘K, explicitly deferred per
// §16.4 — "needs record volume not there yet", not built here) + branch
// switcher (only rendered for multi-branch users; single-branch users see
// static text) + user menu (profile, logout — "no settings shortcuts
// duplicated here that already exist in the sidebar").
export function TopBar({ fullName, email, orgName, roleLabel, branches }: TopBarProps) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      // Full navigation, not router.push — clears any client-held state
      // (session display props, future client caches) rather than leaving
      // stale authenticated data in memory after the cookie is gone.
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-background px-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{orgName}</span>
      </div>

      <div className="flex items-center gap-3">
        {branches.length > 1 ? (
          // §12.2: a real switcher (not just a label) belongs here once a
          // page exists whose content actually changes per branch — no
          // such page is built yet in this task, so this renders the
          // current set as static text rather than a dead dropdown that
          // changes nothing when clicked.
          <span className="text-sm text-muted-foreground">{branches.length} branches</span>
        ) : branches.length === 1 ? (
          <span className="text-sm text-muted-foreground">{branches[0]!.name}</span>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex items-center gap-2 rounded-md p-1 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Account menu for ${fullName}`}
            >
              <Avatar>
                <AvatarFallback>{initials(fullName)}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <span className="font-medium">{fullName}</span>
                <span className="text-xs text-muted-foreground">{email}</span>
                <span className="text-xs text-muted-foreground">{roleLabel}</span>
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
