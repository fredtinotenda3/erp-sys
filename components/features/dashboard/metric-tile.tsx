import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Unavailable } from "@/components/ui/provenance";
import { cn } from "@/lib/utils";

// One tile = one operational question. A tile whose data can't be loaded says
// so (Unavailable + reason); it never shows a placeholder number.
export function MetricTile({
  label,
  value,
  detail,
  href,
  tone = "default",
  unavailableReason,
}: {
  label: string;
  value?: string | number;
  detail?: string;
  href?: string;
  tone?: "default" | "danger" | "warning";
  unavailableReason?: string;
}) {
  const body = (
    <Card className={cn("h-full p-4 transition-colors", href && "hover:border-ring/60", tone === "danger" && "border-status-danger/40", tone === "warning" && "border-status-warning/40")}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 min-h-8">
        {unavailableReason !== undefined ? (
          <Unavailable reason={unavailableReason} />
        ) : (
          <p className={cn("text-2xl font-semibold tabular-nums leading-8", tone === "danger" && "text-status-danger", tone === "warning" && "text-status-warning")}>{value}</p>
        )}
      </div>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </Card>
  );
  return href && unavailableReason === undefined ? (
    <Link href={href} className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {body}
    </Link>
  ) : (
    body
  );
}
