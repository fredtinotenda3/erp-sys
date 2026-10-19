import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

export interface TabItem {
  key: string;
  label: string;
  href: string;
  /** Not built yet: shown, but inert and labelled. Never a link that goes nowhere. */
  unavailable?: boolean;
}

// URL-driven tabs: each tab is a real link (?tab=...), so the server renders
// only the active tab's data, the back button works, and tabs are shareable.
export function TabsNav({ tabs, active, label }: { tabs: TabItem[]; active: string; label: string }) {
  return (
    <nav aria-label={label} className="mb-4 border-b border-border">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const isActive = t.key === active;
          if (t.unavailable) {
            return (
              <li key={t.key}>
                <span
                  aria-disabled="true"
                  title="Not available yet"
                  className="flex cursor-not-allowed items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm text-muted-foreground/70"
                >
                  {t.label}
                  <span className="provenance-unavailable-pattern rounded border border-status-unavailable-line px-1 text-[10px] leading-4">Not built</span>
                </span>
              </li>
            );
          }
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap border-b-2 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
