import { TabsNav } from "@/components/ui/tabs-nav";
import { hasCapability, type Role } from "../../../src/server/shared/authz";

// Same rule as the sidebar: a tab appears only when the role has its capability. The pages
// and services re-check on the server regardless.
export function SettingsNav({ role, active }: { role: Role; active: "users" | "branches" | "audit-log" | "industry-profile" }) {
  const tabs = [
    { key: "users", label: "Users", href: "/settings/users", cap: "user:read" as const },
    { key: "branches", label: "Branches", href: "/settings/branches", cap: "branch:read" as const },
    { key: "audit-log", label: "Audit log", href: "/settings/audit-log", cap: "audit_log:read" as const },
    { key: "industry-profile", label: "Manufacturing profile", href: "/settings/industry-profile", cap: "industry_profile:manage" as const },
  ].filter((t) => hasCapability(role, t.cap));
  return <TabsNav tabs={tabs} active={active} label="Settings sections" />;
}
