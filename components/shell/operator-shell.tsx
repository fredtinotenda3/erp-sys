"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";

// The PRODUCTION_OPERATOR shell (UX spec §1.6/§9.5): one header, no management navigation, large
// touch targets. It hides nothing that matters for security -- every page and service re-checks
// the operator's capabilities on the server.
export function OperatorShell({ orgName, fullName, children }: { orgName: string; fullName: string; children: ReactNode }) {
  const router = useRouter();
  const [out, setOut] = useState(false);
  async function logout() {
    setOut(true);
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground">Skip to main content</a>
      <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <Link href="/shop-floor" className="text-base font-semibold">{orgName} · Shop floor</Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden sm:inline">{fullName}</span>
          <Button variant="outline" className="h-11 px-4" disabled={out} onClick={logout}><LogOut /> Sign out</Button>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 p-4 outline-none sm:p-6">{children}</main>
    </div>
  );
}
