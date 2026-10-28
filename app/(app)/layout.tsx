import type { ReactNode } from "react";

import { Sidebar } from "../../components/shell/sidebar";
import { TopBar } from "../../components/shell/top-bar";
import { OperatorShell } from "../../components/shell/operator-shell";
import { getVisibleNavItems } from "../../components/shell/nav-config";
import { getPageContext } from "../../lib/server/page-context";

// Authenticated shell. Session validation reuses the existing session service
// (via getPageContext, which redirects to /login when there is no valid
// session). The sidebar is filtered by the user's CAPABILITIES; that is a
// usability measure only -- every page and service re-checks on the server.
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const ctx = await getPageContext();
  const { session, me } = ctx;

  // §1.6 / §9.5: PRODUCTION_OPERATOR gets a structurally different, tablet-first shell. It shows
  // no management navigation; what an operator can actually open is decided by their capabilities
  // on the server, not by what this shell links to.
  if (session.role === "PRODUCTION_OPERATOR") {
    return (
      <OperatorShell orgName={me.orgName} fullName={me.fullName}>
        {children}
      </OperatorShell>
    );
  }

  const navItems = getVisibleNavItems(session.role);

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <Sidebar items={navItems} orgName={me.orgName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          fullName={me.fullName}
          email={me.email}
          orgName={me.orgName}
          roleLabel={formatRoleLabel(session.role)}
          branches={me.branches}
          selectedBranchId={ctx.selectedBranchId}
          navItems={navItems}
        />
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1400px] flex-1 p-4 outline-none sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}

function formatRoleLabel(role: string): string {
  return role
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
