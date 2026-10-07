import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { SESSION_COOKIE_NAME } from "../../src/server/shared/http";
import { validateSessionToken } from "../../src/server/modules/iam/session-service";
import { getCurrentUserDisplay } from "../../src/server/modules/iam/me-service";
import { Sidebar } from "../../components/shell/sidebar";
import { TopBar } from "../../components/shell/top-bar";

// NOTE on the prop type below: the root layout (app/layout.tsx) uses Next
// 16's generated `LayoutProps<"/">` type, which `next dev`/`next build`
// write into `.next/types/`. This sandbox can't run either (no DB, and the
// usual verification gap — see the Catalog/Customers delivery notes), so
// there's no way to confirm the exact generated union type a ROUTE GROUP
// layout gets here (it covers every page under `(app)`, not one literal
// path). `{ children: ReactNode }` is the plain, always-valid App Router
// signature regardless of what that union turns out to be — switch this to
// its typed-routes equivalent on your machine if you want full consistency
// with the root layout; it's a style choice, not a behavior difference.
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await validateSessionToken(token) : null;

  if (!session) {
    redirect("/login");
  }

  // §1.6 / §9.5: PRODUCTION_OPERATOR gets no sidebar at all — a
  // structurally different shell, not the manager chrome with fewer items
  // filtered in. The operator's actual workspace (Production Board + their
  // assigned job only) is Production-module UI that doesn't exist yet, so
  // this renders an honest "not available yet" state rather than either
  // the manager shell (wrong) or a blank page (unexplained).
  if (session.role === "PRODUCTION_OPERATOR") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          The operator workspace isn&apos;t available yet — it ships with the Production module. Ask your manager if you
          need something in the meantime.
        </p>
      </div>
    );
  }

  const me = await getCurrentUserDisplay(session);

  return (
    <div className="flex min-h-screen">
      <Sidebar role={session.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          fullName={me.fullName}
          email={me.email}
          orgName={me.orgName}
          roleLabel={formatRoleLabel(session.role)}
          branches={me.branches}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
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
