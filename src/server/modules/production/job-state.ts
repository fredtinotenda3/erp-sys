// Production job state machine (this slice). Pure functions -- no I/O -- so
// the rules are unit-testable on their own.
//
//   planned     -> released | cancelled
//   released    -> in_progress | on_hold | cancelled
//   in_progress -> on_hold | completed
//   on_hold     -> released (if work never started) | in_progress (if it had)
//   completed   -> closed
//   closed, cancelled: terminal
//
// A job cannot be cancelled once in_progress: material may already be
// consumed, and consumed stock cannot simply vanish (ARCHITECTURE.md §5) --
// it must be completed, or written off through an inventory adjustment.
export const JOB_STATUS_VALUES = [
  "planned",
  "released",
  "in_progress",
  "on_hold",
  "completed",
  "closed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUS_VALUES)[number];

export function allowedTransitions(status: JobStatus, hasStarted: boolean): JobStatus[] {
  switch (status) {
    case "planned":
      return ["released", "cancelled"];
    case "released":
      return ["in_progress", "on_hold", "cancelled"];
    case "in_progress":
      return ["on_hold", "completed"];
    case "on_hold":
      return [hasStarted ? "in_progress" : "released"];
    case "completed":
      return ["closed"];
    case "closed":
    case "cancelled":
      return [];
  }
}

export function canTransition(from: JobStatus, to: JobStatus, hasStarted: boolean): boolean {
  return allowedTransitions(from, hasStarted).includes(to);
}

// Statuses in which work (labour, and later material issue) may be recorded.
export function acceptsWork(status: JobStatus): boolean {
  return status === "released" || status === "in_progress";
}
