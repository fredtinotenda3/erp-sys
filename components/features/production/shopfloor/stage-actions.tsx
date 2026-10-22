"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { StageView } from "@/lib/api-types";

// Start / complete / block / unblock one stage. Which buttons appear mirrors the
// server's rules (and "complete" is disabled with the server's own reasons when
// something is missing), but the server decides: a stale button just gets a 409
// whose message is shown.
export function StageActions({ jobId, stage }: { jobId: string; stage: StageView }) {
  const router = useRouter();
  const sub = useSubmission();
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();

  async function run(action: "start" | "complete" | "unblock") {
    const r = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/stages/${stage.id}/transition`, { method: "POST", body: { action } }));
    if (r?.ok) router.refresh();
  }

  async function block() {
    if (reason.trim().length < 3) return setReasonError("Say why (at least 3 characters).");
    const r = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/stages/${stage.id}/transition`, { method: "POST", body: { action: "block", reason: reason.trim() } }));
    if (r?.ok) {
      setBlocking(false);
      setReason("");
      router.refresh();
    }
  }

  if (stage.status === "completed") return <span className="text-xs text-muted-foreground">Completed</span>;
  const blocked = stage.blockedReason !== null;
  const completeBlocked = stage.completionBlockers.length > 0;

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {stage.status === "pending" && !blocked ? (
        <Button type="button" size="sm" onClick={() => run("start")} disabled={sub.pending}>
          Start
        </Button>
      ) : null}
      {stage.status === "in_progress" && !blocked ? (
        <Button type="button" size="sm" onClick={() => run("complete")} disabled={sub.pending || completeBlocked} title={completeBlocked ? stage.completionBlockers.join(" ") : undefined} aria-describedby={completeBlocked ? `blk-${stage.id}` : undefined}>
          Complete
        </Button>
      ) : null}
      {blocked ? (
        <Button type="button" size="sm" variant="outline" onClick={() => run("unblock")} disabled={sub.pending}>
          Unblock
        </Button>
      ) : (
        <Button type="button" size="sm" variant="ghost" onClick={() => setBlocking(true)} disabled={sub.pending}>
          Block
        </Button>
      )}
      {sub.error && !blocking ? <p role="alert" className="basis-full text-right text-xs text-destructive">{sub.error}</p> : null}
      <Modal
        open={blocking}
        onClose={() => !sub.pending && setBlocking(false)}
        dismissible={!sub.pending}
        size="sm"
        title={`Block “${stage.name}”?`}
        description="Output can't be recorded and the stage can't start or complete until it is unblocked."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setBlocking(false)} disabled={sub.pending}>
              Cancel
            </Button>
            <Button type="button" onClick={block} disabled={sub.pending} aria-busy={sub.pending}>
              {sub.pending ? "Blocking…" : "Block stage"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormError message={sub.error} />
          <Field id={`blk-reason-${stage.id}`} label="Reason" required error={reasonError}>
            <Textarea id={`blk-reason-${stage.id}`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setReasonError(undefined); }} aria-invalid={Boolean(reasonError) || undefined} aria-describedby={describedBy(`blk-reason-${stage.id}`, { error: reasonError })} />
          </Field>
          <Notice tone="neutral">The reason is kept in the audit history.</Notice>
        </div>
      </Modal>
    </div>
  );
}
