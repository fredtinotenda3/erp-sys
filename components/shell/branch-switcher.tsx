"use client";

import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";

import { Select } from "../ui/select";
import { BRANCH_COOKIE } from "@/lib/branch-cookie";


// Branch context. Single-branch users see their branch as static text (no dead
// dropdown, UX spec §12.2). Multi-branch users choose "All branches" or one;
// the choice is a cookie that only sets the DEFAULT filter for list pages. It
// is a preference, not authorization: every service re-checks branch access.
export function BranchSwitcher({ branches, selectedId }: { branches: { id: string; name: string }[]; selectedId: string | null }) {
  const router = useRouter();

  if (branches.length === 0) return <span className="text-sm text-muted-foreground">No branch access</span>;

  if (branches.length === 1) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Building2 className="size-4" aria-hidden="true" />
        {branches[0]!.name}
      </span>
    );
  }

  function choose(value: string) {
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = value
      ? `${BRANCH_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; samesite=lax`
      : `${BRANCH_COOKIE}=; path=/; max-age=0; samesite=lax`;
    router.refresh();
  }

  return (
    <label className="flex items-center gap-1.5 text-sm">
      <Building2 className="size-4 text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">Branch</span>
      <Select value={selectedId ?? ""} onChange={(e) => choose(e.target.value)} className="h-8 w-40 sm:w-48">
        <option value="">All branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
