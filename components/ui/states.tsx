import * as React from "react";
import { Inbox, LockKeyhole, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "./card";

function Shell({ icon, title, children, className }: { icon: React.ReactNode; title: string; children?: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("flex flex-col items-center gap-2 px-6 py-10 text-center", className)}>
      <div className="text-muted-foreground" aria-hidden="true">
        {icon}
      </div>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </Card>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Shell icon={<Inbox className="size-6" />} title={title}>
      {children}
      {action ? <div className="mt-3">{action}</div> : null}
    </Shell>
  );
}

/** A failed or partial load. Always says what failed and what to do. */
export function ErrorState({ title = "Couldn't load this data", message, action }: { title?: string; message: string; action?: React.ReactNode }) {
  return (
    <Shell icon={<TriangleAlert className="size-6 text-status-danger" />} title={title}>
      <p>{message}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </Shell>
  );
}

/** Rendered when the server refuses (403) or the role lacks a capability. The server is the authority; this is the explanation. */
export function AccessDenied({ what = "this page" }: { what?: string }) {
  return (
    <Shell icon={<LockKeyhole className="size-6" />} title="You don't have access">
      <p>Your role doesn&apos;t include permission to view {what}. Ask an administrator if you need it.</p>
    </Shell>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

/** Maps a failed Loaded<T> to the right state component. */
export function LoadFailure({ status, message, what }: { status: number; message: string; what: string }) {
  if (status === 403) return <AccessDenied what={what} />;
  return <ErrorState message={message} />;
}
