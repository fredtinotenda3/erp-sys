import * as React from "react";
import { Badge } from "./badge";
import { formatMoney, formatQuantity } from "@/lib/format";

// UX spec §5.2: every figure carries its provenance, so PLANNED / ACTUAL /
// CALCULATED / ESTIMATED / UNAVAILABLE are literal labels, not colours.
const KINDS = {
  planned: { variant: "provenance-planned", text: "Planned", hint: "Set before work started" },
  actual: { variant: "provenance-actual", text: "Actual", hint: "Recorded from a real event" },
  calculated: { variant: "provenance-calculated", text: "Calculated", hint: "Derived live from current records; changes if they change" },
  estimated: { variant: "provenance-estimated", text: "Estimated", hint: "A forecast, not a recorded fact" },
  unavailable: { variant: "provenance-unavailable", text: "Unavailable", hint: "No source data exists" },
} as const;

export type ProvenanceKind = keyof typeof KINDS;

export function Provenance({ kind, label }: { kind: ProvenanceKind; label?: string }) {
  const k = KINDS[kind];
  return (
    <Badge variant={k.variant} title={k.hint}>
      {label ?? k.text}
    </Badge>
  );
}

/** An amount with its own currency. Null renders as UNAVAILABLE, never as zero. */
export function Money({ amount, currency, unavailableReason }: { amount: string | null | undefined; currency: string | null | undefined; unavailableReason?: string }) {
  if (amount === null || amount === undefined) return <Unavailable reason={unavailableReason} />;
  const text = formatMoney(amount, currency);
  return <span className="whitespace-nowrap tabular-nums">{text}</span>;
}

export function Quantity({ value, uom }: { value: string | null | undefined; uom?: string | null }) {
  return <span className="whitespace-nowrap tabular-nums">{formatQuantity(value, uom)}</span>;
}

export function Unavailable({ reason }: { reason?: string }) {
  return (
    <span className="provenance-unavailable-pattern inline-block rounded border border-status-unavailable-line px-1.5 py-0.5 text-xs text-muted-foreground">
      Unavailable{reason ? ` — ${reason}` : ""}
    </span>
  );
}
