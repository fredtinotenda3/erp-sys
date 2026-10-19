import * as React from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";

type Tone = "info" | "success" | "warning" | "danger" | "neutral";

const TONES: Record<Tone, { box: string; icon: React.ComponentType<{ className?: string }> }> = {
  info: { box: "bg-status-info-bg text-status-info", icon: Info },
  success: { box: "bg-status-success-bg text-status-success", icon: CircleCheck },
  warning: { box: "bg-status-warning-bg text-status-warning", icon: TriangleAlert },
  danger: { box: "bg-status-danger-bg text-status-danger", icon: CircleAlert },
  neutral: { box: "bg-muted text-muted-foreground", icon: Info },
};

// Inline message. Always paired with an icon so meaning never rests on colour
// alone (WCAG 1.4.1). `role="alert"` only for errors; others are polite status.
export function Notice({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = TONES[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex items-start gap-2.5 rounded-md px-3 py-2.5 text-sm", box, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-foreground/90">{children}</div> : null}
      </div>
    </div>
  );
}
