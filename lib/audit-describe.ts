// Turns an audit row into a readable sentence using only what the row holds.
// Nothing is inferred beyond the recorded before/after values and reason.
import type { AuditEntry } from "./api-types";
import { humanize } from "./format";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function describeAudit(e: AuditEntry): string {
  const before = asRecord(e.beforeValue);
  const after = asRecord(e.afterValue);
  const subject = humanize(e.entityType.replace(/_/g, " "));

  if (e.action === "transition" && before && after && "status" in before && "status" in after) {
    return `${subject} status changed from ${String(before.status).replace(/_/g, " ")} to ${String(after.status).replace(/_/g, " ")}`;
  }
  if (e.action === "update" && after) {
    const fields = Object.keys(after).map((k) => humanize(k.replace(/([A-Z])/g, "_$1").toLowerCase()).toLowerCase());
    return fields.length ? `${subject} updated (${fields.join(", ")})` : `${subject} updated`;
  }
  if (e.action === "create") return `${subject} created`;
  return `${subject} ${e.action}`;
}
