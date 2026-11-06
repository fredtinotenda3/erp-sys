"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Select } from "@/components/ui/select";
import { CorrectiveActionStatusBadge } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { CorrectiveActionView, CorrectiveActionStatus } from "@/lib/api-types";

function ResolveRow({ jobId, action, canManage, nameOf }: { jobId: string; action: CorrectiveActionView; canManage: boolean; nameOf: (id: string | null) => string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<CorrectiveActionStatus>(action.status === "open" ? "in_progress" : "completed");
  const [notes, setNotes] = useState("");
  const closed = action.status === "completed" || action.status === "cancelled";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const closing = status === "completed" || status === "cancelled";
    if (closing && notes.trim().length === 0) return sub.fail("Resolution notes are required to close this action.", { resolutionNotes: "Required to close this action." });
    const r = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/corrective-actions/${action.id}`, { method: "PATCH", body: { status, ...(notes.trim() ? { resolutionNotes: notes.trim() } : {}) } }), {
      visibleFields: ["status", "resolutionNotes"],
    });
    if (r?.ok) {
      setEditing(false);
      setNotes("");
      router.refresh();
    }
  }

  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="flex items-center gap-2">
            <CorrectiveActionStatusBadge status={action.status} />
            {action.dueDate ? <span className="text-xs text-muted-foreground">Due {new Date(action.dueDate).toLocaleDateString()}</span> : null}
          </span>
          <p className="mt-1">{action.description}</p>
          <p className="text-xs text-muted-foreground">
            Assigned to {nameOf(action.assignedToUserId)} · opened by {nameOf(action.createdById)}, <LocalTime iso={action.createdAt} />
          </p>
          {action.resolutionNotes ? <p className="text-xs text-muted-foreground">Resolution: {action.resolutionNotes}</p> : null}
        </div>
        {canManage && !closed ? (
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel" : "Update"}
          </button>
        ) : null}
      </div>
      {editing ? (
        <form onSubmit={submit} className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <FormError message={sub.error} />
          <Field id={`ca-status-${action.id}`} label="Status" required>
            <Select id={`ca-status-${action.id}`} value={status} onChange={(e) => setStatus(e.target.value as CorrectiveActionStatus)}>
              <option value="in_progress">In progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
          </Field>
          <Field id={`ca-notes-${action.id}`} label="Resolution notes" required={status === "completed" || status === "cancelled"} error={sub.fieldErrors.resolutionNotes} hint="Required when closing (completed/cancelled).">
            <Textarea id={`ca-notes-${action.id}`} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} aria-describedby={describedBy(`ca-notes-${action.id}`, { error: sub.fieldErrors.resolutionNotes })} />
          </Field>
          <SubmitButton pending={sub.pending} pendingLabel="Saving…">
            Save
          </SubmitButton>
        </form>
      ) : null}
    </li>
  );
}

// Root-cause follow-up tracker for a job -- distinct from a quality
// disposition (which only decides what happens to the rejected units).
export function CorrectiveActionsPanel({
  jobId,
  actions,
  canManage,
  nameOf,
  users,
}: {
  jobId: string;
  actions: CorrectiveActionView[];
  canManage: boolean;
  nameOf: (id: string | null) => string;
  users: { id: string; fullName: string }[];
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [description, setDescription] = useState("");
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (description.trim().length < 5) problems.description = "Describe the corrective action in at least 5 characters.";
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");

    const result = await sub.run(
      () =>
        apiRequest(`/api/v1/production-jobs/${jobId}/corrective-actions`, {
          method: "POST",
          body: { description: description.trim(), ...(assignedToUserId ? { assignedToUserId } : {}), ...(dueDate ? { dueDate } : {}) },
        }),
      { visibleFields: ["description", "assignedToUserId", "dueDate"] },
    );
    if (result?.ok) {
      setDescription("");
      setAssignedToUserId("");
      setDueDate("");
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Corrective actions</CardTitle>
        <span className="text-xs text-muted-foreground">{actions.filter((a) => a.status === "open" || a.status === "in_progress").length} open</span>
      </CardHeader>
      {actions.length === 0 ? (
        <CardContent className="text-sm text-muted-foreground">No corrective actions have been raised for this job.</CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {actions.map((a) => (
            <ResolveRow key={a.id} jobId={jobId} action={a} canManage={canManage} nameOf={nameOf} />
          ))}
        </ul>
      )}
      {canManage ? (
        <CardContent className="border-t border-border">
          <form onSubmit={onSubmit} noValidate className="space-y-3">
            <FormError message={sub.error} />
            <Field id="ca-new-desc" label="Describe the corrective action" required error={errors.description}>
              <Textarea id="ca-new-desc" rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} aria-invalid={Boolean(errors.description) || undefined} aria-describedby={describedBy("ca-new-desc", { error: errors.description })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id="ca-new-assignee" label="Assign to" hint="Optional">
                <Select id="ca-new-assignee" value={assignedToUserId} onChange={(e) => setAssignedToUserId(e.target.value)}>
                  <option value="">Unassigned</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.fullName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="ca-new-due" label="Due date" hint="Optional">
                <Input id="ca-new-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </Field>
            </div>
            <SubmitButton pending={sub.pending} pendingLabel="Raising…">
              Raise corrective action
            </SubmitButton>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}
