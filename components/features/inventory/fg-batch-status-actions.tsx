"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, CircleCheck, CircleX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";

type Dialog = "quarantine" | "release" | "reject" | null;

// Manual quality-disposition change for one finished-goods batch, mirroring
// lot-status-actions.tsx's confirm/reason pattern. finished-goods-service.ts's
// setBatchStatus itself permits any active/quarantined/rejected transition
// (it's a generic optimistic-concurrency status write, not a state machine),
// but the UI only offers the transitions a quality workflow actually uses --
// "rejected" is treated as terminal here, the same way lots treat "expired":
// reversing a rejection is rare enough to go through direct API access rather
// than a one-click button that could be mis-clicked.
export function FgBatchStatusActions({ batchId, batchNumber, status }: { batchId: string; batchNumber: string; status: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState("");

  async function submit(kind: "quarantine" | "release" | "reject") {
    if (reason.trim().length < 3) return sub.fail("Say why in at least 3 characters.", { reason: "Say why in at least 3 characters." });
    const target = kind === "quarantine" ? "quarantined" : kind === "release" ? "active" : "rejected";
    const r = await sub.run(() => apiRequest(`/api/v1/inventory/finished-goods/${batchId}/status`, { method: "POST", body: { status: target, reason: reason.trim() } }));
    if (r?.ok) {
      setDialog(null);
      setReason("");
      router.refresh();
    }
  }
  const close = () => {
    if (!sub.pending) {
      setDialog(null);
      sub.clear();
    }
  };

  if (status === "rejected") return null;

  return (
    <>
      {status === "active" ? (
        <Button variant="outline" onClick={() => setDialog("quarantine")}>
          <Ban /> Quarantine
        </Button>
      ) : null}
      {status === "quarantined" ? (
        <Button variant="outline" onClick={() => setDialog("release")}>
          <CircleCheck /> Release to active
        </Button>
      ) : null}
      <Button variant="outline" onClick={() => setDialog("reject")}>
        <CircleX /> Reject
      </Button>

      <Modal
        open={dialog === "quarantine"}
        onClose={close}
        title={`Quarantine batch ${batchNumber}?`}
        description="A quarantined batch is still on hand but shouldn't be transferred or dispatched until it's released back to active."
        footer={
          <>
            <Button variant="outline" onClick={close} disabled={sub.pending}>
              Not yet
            </Button>
            <SubmitButton pending={sub.pending} pendingLabel="Quarantining…" variant="destructive" form="quarantine-fg-batch">
              Quarantine batch
            </SubmitButton>
          </>
        }
      >
        <form id="quarantine-fg-batch" onSubmit={(e) => { e.preventDefault(); void submit("quarantine"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="quarantine-fg-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="quarantine-fg-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === "release"}
        onClose={close}
        title={`Release batch ${batchNumber} to active?`}
        description="This makes the batch available to transfer or dispatch again."
        footer={
          <>
            <Button variant="outline" onClick={close} disabled={sub.pending}>
              Not yet
            </Button>
            <SubmitButton pending={sub.pending} pendingLabel="Releasing…" form="release-fg-batch">
              Release batch
            </SubmitButton>
          </>
        }
      >
        <form id="release-fg-batch" onSubmit={(e) => { e.preventDefault(); void submit("release"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="release-fg-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="release-fg-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === "reject"}
        onClose={close}
        title={`Reject batch ${batchNumber}?`}
        description="Marks this batch as rejected (failed quality). It stays on the stock ledger -- rejecting it does not remove the stock on hand or change its value; use an adjustment for that."
        footer={
          <>
            <Button variant="outline" onClick={close} disabled={sub.pending}>
              Not yet
            </Button>
            <SubmitButton pending={sub.pending} pendingLabel="Rejecting…" variant="destructive" form="reject-fg-batch">
              Reject batch
            </SubmitButton>
          </>
        }
      >
        <form id="reject-fg-batch" onSubmit={(e) => { e.preventDefault(); void submit("reject"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="reject-fg-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="reject-fg-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
