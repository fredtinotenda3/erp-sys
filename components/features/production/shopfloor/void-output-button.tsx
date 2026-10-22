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

export function VoidOutputButton({ jobId, outputId, summary }: { jobId: string; outputId: string; summary: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | undefined>();

  async function confirm() {
    if (reason.trim().length < 5) return setErr("Explain why (at least 5 characters).");
    const r = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/output/${outputId}/void`, { method: "POST", body: { reason: reason.trim() } }));
    if (r?.ok) {
      setOpen(false);
      router.refresh();
    }
  }
  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Void
      </Button>
      <Modal
        open={open}
        onClose={() => !sub.pending && setOpen(false)}
        dismissible={!sub.pending}
        size="sm"
        title="Void this output entry?"
        description={`${summary}. The entry stays in the history, marked void and excluded from totals. This can't be undone.`}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={sub.pending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirm} disabled={sub.pending} aria-busy={sub.pending}>
              {sub.pending ? "Voiding…" : "Void entry"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormError message={sub.error} />
          <Field id={`void-${outputId}`} label="Reason" required error={err}>
            <Textarea id={`void-${outputId}`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setErr(undefined); }} aria-invalid={Boolean(err) || undefined} aria-describedby={describedBy(`void-${outputId}`, { error: err })} />
          </Field>
        </div>
      </Modal>
    </>
  );
}
