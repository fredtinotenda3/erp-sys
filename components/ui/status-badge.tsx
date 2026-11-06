import * as React from "react";
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CirclePlay,
  CircleX,
  Lock,
  Pause,
  Send,
  TriangleAlert,
  Truck,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "./badge";
import { humanize } from "@/lib/format";

type Variant = "status-neutral" | "status-info" | "status-warning" | "status-danger" | "status-success";

// One fixed semantic palette for every status concept (UX spec §10.2), always
// paired with an icon so colour is never the only signal.
const JOB: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  planned: { variant: "status-neutral", icon: CircleDashed, label: "Planned" },
  released: { variant: "status-info", icon: Send, label: "Released" },
  in_progress: { variant: "status-info", icon: CirclePlay, label: "In progress" },
  on_hold: { variant: "status-warning", icon: Pause, label: "On hold" },
  completed: { variant: "status-success", icon: CircleCheck, label: "Completed" },
  closed: { variant: "status-success", icon: Lock, label: "Closed" },
  cancelled: { variant: "status-danger", icon: Ban, label: "Cancelled" },
};

export function JobStatusBadge({ status }: { status: string }) {
  const s = JOB[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export function OverdueBadge() {
  return (
    <Badge variant="status-danger" title="Planned end date has passed and the job is not completed">
      <TriangleAlert aria-hidden="true" />
      Overdue
    </Badge>
  );
}

const STOCK: Record<"shortage" | "low" | "ok", { variant: Variant; icon: LucideIcon; label: string }> = {
  shortage: { variant: "status-danger", icon: TriangleAlert, label: "Shortage" },
  low: { variant: "status-warning", icon: TriangleAlert, label: "Low" },
  ok: { variant: "status-success", icon: CircleCheck, label: "OK" },
};

export function StockStatusBadge({ status }: { status: "shortage" | "low" | "ok" }) {
  const s = STOCK[status];
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="status-success">
      <CircleCheck aria-hidden="true" />
      Active
    </Badge>
  ) : (
    <Badge variant="status-neutral">
      <CircleX aria-hidden="true" />
      Inactive
    </Badge>
  );
}

const ORDER: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  draft: { variant: "status-neutral", icon: CircleDashed, label: "Draft" },
  confirmed: { variant: "status-info", icon: CircleCheck, label: "Confirmed" },
  in_production: { variant: "status-info", icon: CirclePlay, label: "In production" },
  partially_delivered: { variant: "status-warning", icon: Pause, label: "Partially delivered" },
  delivered: { variant: "status-success", icon: CircleCheck, label: "Delivered" },
  closed: { variant: "status-success", icon: Lock, label: "Closed" },
  cancelled: { variant: "status-danger", icon: Ban, label: "Cancelled" },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const s = ORDER[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const PURCHASE_ORDER: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  draft: { variant: "status-neutral", icon: CircleDashed, label: "Draft" },
  confirmed: { variant: "status-info", icon: CircleCheck, label: "Confirmed" },
  partially_received: { variant: "status-warning", icon: Pause, label: "Partially received" },
  received: { variant: "status-success", icon: CircleCheck, label: "Received" },
  closed: { variant: "status-success", icon: Lock, label: "Closed" },
  cancelled: { variant: "status-danger", icon: Ban, label: "Cancelled" },
};

export function PurchaseOrderStatusBadge({ status }: { status: string }) {
  const s = PURCHASE_ORDER[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const LOT: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  active: { variant: "status-success", icon: CircleCheck, label: "Active" },
  quarantined: { variant: "status-warning", icon: Ban, label: "Quarantined" },
  expired: { variant: "status-danger", icon: TriangleAlert, label: "Expired" },
};

export function LotStatusBadge({ status }: { status: string }) {
  const s = LOT[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

// Finished-goods batches use a 3-way disposition (no "expired" -- a finished
// batch isn't aged the way a received material lot is; see
// finished-goods-service.ts's statusSchema). "rejected" is deliberately
// terminal-looking (danger, not warning) since transferBatch refuses to move
// a rejected batch.
const FG_BATCH: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  active: { variant: "status-success", icon: CircleCheck, label: "Active" },
  quarantined: { variant: "status-warning", icon: Ban, label: "Quarantined" },
  rejected: { variant: "status-danger", icon: CircleX, label: "Rejected" },
};

export function FgBatchStatusBadge({ status }: { status: string }) {
  const s = FG_BATCH[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

// Dispatch (Milestone 3): "dispatched" is informational, not a problem state
// (goods have correctly left the warehouse and are in transit) -- info, not
// warning, matching JOB's own "released"/"in_progress" treatment rather
// than FG_BATCH's "quarantined" one.
const DISPATCH: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  dispatched: { variant: "status-info", icon: Truck, label: "Dispatched" },
  delivered: { variant: "status-success", icon: CircleCheck, label: "Delivered" },
};

export function DispatchStatusBadge({ status }: { status: string }) {
  const s = DISPATCH[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

// Machine status: "down" and "maintenance" are both treated as warning (not
// error) since they are normal, expected operational states with a defined
// recovery path (close downtime / complete maintenance), not failures of the
// system itself. "retired" is neutral, matching how other terminal/inactive
// states (e.g. a deactivated item) are rendered elsewhere in this file.
const MACHINE: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  available: { variant: "status-success", icon: CircleCheck, label: "Available" },
  in_use: { variant: "status-info", icon: CircleDashed, label: "In use" },
  down: { variant: "status-warning", icon: CircleDashed, label: "Down" },
  maintenance: { variant: "status-warning", icon: CircleDashed, label: "Maintenance" },
  retired: { variant: "status-neutral", icon: CircleDashed, label: "Retired" },
};

export function MachineStatusBadge({ status }: { status: string }) {
  const s = MACHINE[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

const CORRECTIVE_ACTION: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  open: { variant: "status-warning", icon: TriangleAlert, label: "Open" },
  in_progress: { variant: "status-info", icon: CirclePlay, label: "In progress" },
  completed: { variant: "status-success", icon: CircleCheck, label: "Completed" },
  cancelled: { variant: "status-neutral", icon: Ban, label: "Cancelled" },
};

export function CorrectiveActionStatusBadge({ status }: { status: string }) {
  const s = CORRECTIVE_ACTION[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}

// Mould status (Milestone 6): same four states and the same semantic
// reasoning as MACHINE above ("maintenance"/"retired" are expected
// operational states, not failures -- there is no "down" state for a mould
// the way there is for a machine, since a mould doesn't break mid-run the
// way a machine can; a damaged mould goes straight to "maintenance").
const MOULD: Record<string, { variant: Variant; icon: LucideIcon; label: string }> = {
  available: { variant: "status-success", icon: CircleCheck, label: "Available" },
  in_use: { variant: "status-info", icon: CircleDashed, label: "In use" },
  maintenance: { variant: "status-warning", icon: CircleDashed, label: "Maintenance" },
  retired: { variant: "status-neutral", icon: CircleDashed, label: "Retired" },
};

export function MouldStatusBadge({ status }: { status: string }) {
  const s = MOULD[status] ?? { variant: "status-neutral" as Variant, icon: CircleDashed, label: humanize(status) };
  const Icon = s.icon;
  return (
    <Badge variant={s.variant}>
      <Icon aria-hidden="true" />
      {s.label}
    </Badge>
  );
}
