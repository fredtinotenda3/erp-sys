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
