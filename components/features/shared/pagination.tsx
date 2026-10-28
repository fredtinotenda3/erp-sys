import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

/** Previous/next links that keep the current filters. `page` is 1-based. */
export function Pagination({ basePath, params, page, pageSize, total }: { basePath: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
      <span>{total === 0 ? "No results" : `${from}–${to} of ${total}`}</span>
      <span className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={href(page - 1)} rel="prev" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ChevronLeft /> Previous
          </Link>
        ) : null}
        <span aria-current="page">Page {Math.min(page, pages)} of {pages}</span>
        {page < pages ? (
          <Link href={href(page + 1)} rel="next" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Next <ChevronRight />
          </Link>
        ) : null}
      </span>
    </nav>
  );
}
