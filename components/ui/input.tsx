import * as React from "react";

import { cn } from "@/lib/utils";

// UX_UI_ARCHITECTURE.md §10.3 Forms row: "Label above field, inline
// validation on blur, error text below field in red + icon, never
// color-only." This component is the bare field; the label/error/icon
// wiring is a per-form concern (see app/login/login-form.tsx for the first
// real usage) rather than baked into Input itself, since not every field
// needs all three (e.g. a search box has no error state).
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
