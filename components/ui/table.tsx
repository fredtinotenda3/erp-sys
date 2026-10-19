import * as React from "react";

import { cn } from "@/lib/utils";

// Dense, readable data table. The wrapper scrolls horizontally on narrow
// screens so wide tables never break the page layout.
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="table-scroll">
      <table className={cn("w-full min-w-max border-collapse text-sm tabular-nums", className)} {...props} />
    </div>
  );
}

function THead(props: React.ComponentProps<"thead">) {
  return <thead className="border-b border-border bg-muted/60 text-left text-xs font-medium text-muted-foreground" {...props} />;
}

function TBody(props: React.ComponentProps<"tbody">) {
  return <tbody className="divide-y divide-border" {...props} />;
}

function TR({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("align-top hover:bg-muted/40", className)} {...props} />;
}

function TH({ className, ...props }: React.ComponentProps<"th">) {
  return <th scope="col" className={cn("whitespace-nowrap px-3 py-2 font-medium", className)} {...props} />;
}

function TD({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("px-3 py-2.5", className)} {...props} />;
}

export { Table, THead, TBody, TR, TH, TD };
