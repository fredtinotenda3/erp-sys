"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { allowedTransitions, type JobStatus } from "@/src/server/modules/production/job-state";

interface Spec {
  label: string;
  title: string;
  body: string;
  reasonRequired: boolean;
  destructive?: boolean;
  primary?: boolean;
}

function specFor(from: JobStatus, to: JobStatus): Spec {
  switch (to) {
    case "released":
      return { label: "Release job", title: "Release this job?", body: "It becomes available for material issues and labour.", reasonRequired: false, primary: true };
    case "in_progress":
      return from === "on_hold"
        ? { label: "Resume job", title: "Resume this job?", body: "Work, material issues and labour can continue.", reasonRequired: false, primary: true }
        : { label: "Start job", title: "Start this job?", body: "This records the actual start time.", reasonRequired: false, primary: true };
    case "on_hold":
      return { label: "Put on hold", title: "Put this job on hold?", body: "Material issues and labour are blocked until it is resumed. Say why, so the team knows.", reasonRequired: true };
    case "cancelled":
      return { label: "Cancel job", title: "Cancel this job?", body: "Cancelling is permanent. The job number and its history are kept, but it can't be restarted.", reasonRequired: true, destructive: true };
    case "completed":
      return { label: "Complete job", title: "Complete this job?", body: "Completing records the actual end time and freezes the final material and labour costs. Issues and labour can't be added afterwards.", reasonRequired: false, primary: true };
    case "closed":
      return { label: "Close job", title: "Close this job?", body: "Closing is final. Use it once the job is fully reviewed.", reasonRequired: false };
    default:
      return { label: `Move to ${to.replace(/_/g, " ")}`, title: `Move to ${to.replace(/_/g, " ")}?`, body: "", reasonRequired: false };
  }
}

// Which buttons appear comes from the backend's own state machine
// (allowedTransitions is imported, not re-implemented); the server remains the
// authority and rejects anything the caller isn't allowed to do.
export function JobActions({
  jobId,
  status,
  hasStarted,
  canUpdate,
  canComplete,
}: {
  jobId: string;
  status: JobStatus;
  hasStarted: boolean;
  canUpdate: boolean;
  canComplete: boolean;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [target, setTarget] = useState<JobStatus | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();

  const targets = allowedTransitions(status, hasStarted).filter((t) => (t === "completed" || t === "closed" ? canComplete : canUpdate));
  if (targets.length === 0) return null;
  const spec = target ? specFor(status, target) : null;

  function close() {
    if (sub.pending) return;
    setTarget(null);
    setReason("");
    setReasonError(undefined);
    sub.clear();
  }

  async function confirm() {
    if (!target || !spec) return;
    if (spec.reasonRequired && reason.trim().length === 0) {
      setReasonError("A reason is required.");
      return;
    }
    const result = await sub.run(() =>
      target === "completed"
        ? apiRequest(`/api/v1/production-jobs/${jobId}/complete`, { method: "POST" })
        : apiRequest(`/api/v1/production-jobs/${jobId}/transition`, { method: "POST", body: { status: target, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    );
    if (result?.ok) {
      setTarget(null);
      setReason("");
      router.refresh();
    }
  }

  return (
    <>
      {targets.map((t) => {
        const s = specFor(status, t);
        return (
          <Button key={t} type="button" variant={s.destructive ? "outline" : s.primary ? "primary" : "outline"} className={s.destructive ? "text-destructive" : undefined} onClick={() => setTarget(t)}>
            {s.label}
          </Button>
        );
      })}
      <Modal
        open={target !== null}
        onClose={close}
        dismissible={!sub.pending}
        size="sm"
        title={spec?.title ?? ""}
        description={spec?.body}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close} disabled={sub.pending}>
              Back
            </Button>
            <Button type="button" variant={spec?.destructive ? "destructive" : "primary"} onClick={confirm} disabled={sub.pending} aria-busy={sub.pending}>
              {sub.pending ? "Working…" : spec?.label}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormError message={sub.error} />
          {spec ? (
            <Field id="reason" label={spec.reasonRequired ? "Reason" : "Note (optional)"} required={spec.reasonRequired} error={reasonError}>
              <Textarea id="reason" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setReasonError(undefined); }} aria-invalid={Boolean(reasonError) || undefined} aria-describedby={describedBy("reason", { error: reasonError })} />
            </Field>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
