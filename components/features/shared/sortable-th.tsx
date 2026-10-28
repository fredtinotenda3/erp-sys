import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";

import { TH } from "@/components/ui/table";

/** A column header that links to the same page sorted by this column (toggling direction). */
export function SortableTH({ label, sortKey, basePath, params, sort, dir, className }: { label: string; sortKey: string; basePath: string; params: Record<string, string | undefined>; sort: string; dir: "asc" | "desc"; className?: string }) {
  const active = sort === sortKey;
  const next = active && dir === "asc" ? "desc" : "asc";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, sort: sortKey, dir: next })) if (v) q.set(k, v);
  return (
    <TH className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <Link href={`${basePath}?${q.toString()}`} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        {active ? dir === "asc" ? <ArrowUp className="size-3" aria-hidden="true" /> : <ArrowDown className="size-3" aria-hidden="true" /> : null}
      </Link>
    </TH>
  );
}
