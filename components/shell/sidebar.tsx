import Link from "next/link";

import type { Role } from "../../src/server/shared/authz";
import { getVisibleNavItems } from "./nav-config";

// Server Component — no client-side state needed for a static, role-filtered
// link list. §11.1's icon-only/flyout collapse at the `md` breakpoint is
// pure CSS (Tailwind responsive classes below); it doesn't need JS state
// either, so this stays a Server Component rather than paying for a client
// bundle it doesn't need. If a future revision adds a user-toggled collapse
// (as opposed to the breakpoint-driven one), that toggle alone would need
// to move into a small client wrapper — the link list itself still
// wouldn't.
export function Sidebar({ role }: { role: Role }) {
  const items = getVisibleNavItems(role);

  return (
    <nav
      aria-label="Primary"
      className="flex h-full w-16 flex-col border-r border-border bg-card py-4 md:w-16 lg:w-56"
    >
      <div className="mb-4 px-3 lg:px-4">
        <span className="hidden text-sm font-semibold tracking-wide lg:inline">OPERIS</span>
        <span className="block text-sm font-semibold lg:hidden" aria-hidden="true">
          O
        </span>
      </div>
      <ul className="flex flex-1 flex-col gap-0.5 px-2">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex items-center justify-center rounded-md px-2 py-2 text-sm text-foreground/80 hover:bg-accent hover:text-accent-foreground lg:justify-start lg:px-3"
              title={item.label}
            >
              {/* §11.1: icon-only at md, icon+label at lg. No icon set has
                  been chosen yet for these specific modules (that's a
                  per-item design pass once each module's real screen is
                  built, not a shell-framework concern) — the first letter
                  stands in for now rather than leaving a blank tap target. */}
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium lg:mr-2"
                aria-hidden="true"
              >
                {item.label.charAt(0)}
              </span>
              <span className="hidden lg:inline">{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
