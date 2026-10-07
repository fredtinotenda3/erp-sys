import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Two badge FAMILIES, deliberately visually distinct per
// UX_UI_ARCHITECTURE.md §10.3: "Status chips (§10.2) and the
// PLANNED/ACTUAL/CALCULATED/ESTIMATED/UNAVAILABLE label chips (§5.2) — two
// badge families, visually distinct from each other (status = filled pill,
// data-provenance = outlined chip) so they're never confused at a glance."
//
// - `variant="status-*"` → filled pill, §10.2's 5-color semantic palette.
//   Use for job/order/stock/quality STATUS values only (draft, in_progress,
//   on_hold, cancelled, completed, ...) — never for a numeric figure.
// - `variant="provenance-*"` → outlined chip, §5.2's 5-value label
//   vocabulary. Use next to EVERY numeric figure in the app, literally —
//   never a bare number with no chip. "unavailable" additionally gets the
//   diagonal-hatch pattern utility (globals.css), not just a grey outline,
//   per §10.2's "pattern, not just color" rule — color alone must never be
//   the only signal (WCAG 1.4.1).
//
// Per §10.2/§10.3, every status/provenance chip must also pair with a
// shape or icon at the call site (triangle/circle-check/circle-x/dot) —
// this component supplies the color+shape-of-chip, not the icon itself,
// since the icon is state-specific (which exact status) rather than
// variant-specific (which family).
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&_svg]:size-3 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        "status-neutral": "border-transparent bg-status-neutral-bg text-status-neutral",
        "status-info": "border-transparent bg-status-info-bg text-status-info",
        "status-warning": "border-transparent bg-status-warning-bg text-status-warning",
        "status-danger": "border-transparent bg-status-danger-bg text-status-danger",
        "status-success": "border-transparent bg-status-success-bg text-status-success",
        "provenance-planned": "border-status-neutral/40 bg-transparent text-status-neutral",
        "provenance-actual": "border-foreground/30 bg-transparent text-foreground",
        "provenance-calculated": "border-status-info/40 bg-transparent text-status-info",
        "provenance-estimated": "border-dashed border-status-info/50 bg-transparent text-status-info",
        "provenance-unavailable": "provenance-unavailable-pattern border-status-unavailable-line text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "status-neutral",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
