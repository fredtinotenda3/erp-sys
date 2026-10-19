"use client";

import * as React from "react";
import { X } from "lucide-react";

import { Button } from "./button";
import { cn } from "@/lib/utils";

// Dialog built on the native <dialog> element: focus is trapped and returned,
// Esc closes, the page behind is inert, and it is announced as a modal by
// assistive tech -- without adding a UI dependency. Backdrop click closes.
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg";
  /** false while a request is in flight, so the dialog can't be dismissed mid-submit. */
  dismissible?: boolean;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/40",
        size === "sm" && "max-w-sm",
        size === "md" && "max-w-lg",
        size === "lg" && "max-w-2xl",
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="space-y-1">
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
              {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
            </div>
            <Button type="button" variant="ghost" size="icon" className="-mr-2 -mt-1 size-8" onClick={onClose} disabled={!dismissible} aria-label="Close dialog">
              <X />
            </Button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
