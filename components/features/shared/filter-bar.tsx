import * as React from "react";
import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";

// Filters are a plain GET form: no client JS, the URL is the state (shareable,
// back-button friendly), and the server applies the filter using the API's own
// query support. Controls inside use `name` + `defaultValue`.
export function FilterBar({ children, resetHref }: { children: React.ReactNode; resetHref: string }) {
  return (
    <form method="get" role="search" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
      {children}
      <div className="flex gap-2">
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        <Link href={resetHref} className={buttonVariants({ variant: "ghost" })}>
          Clear
        </Link>
      </div>
    </form>
  );
}

export function FilterField({ id, label, children, className }: { id: string; label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className ?? "min-w-40 flex-1 space-y-1 sm:flex-none"}>
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}