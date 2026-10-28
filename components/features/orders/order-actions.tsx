"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, CircleCheck, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";

// Confirm / cancel an order. Both are explicit, confirmed actions; the page only refreshes
// after the server reports success.
export function OrderActions({ orderId, orderNumber, status, canConfirm, canCancel }: { orderId: string; orderNumber: string; status: string; canConfirm: boolean; canCancel: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [dialog, setDialog] = useState<"confirm" | "cancel" | null>(null);
  const [reason, setReason] = useState("");

  async function submit(kind: "confirm" | "cancel") {
    if (kind === "cancel" && reason.trim().length < 3) return sub.fail("Say why in at least 3 characters.", { reason: "Say why in at least 3 characters." });
    const r = await sub.run(() => apiRequest(`/api/v1/sales-orders/${orderId}/${kind}`, { method: "POST", body: kind === "cancel" ? { reason: reason.trim() } : {} }));
    if (r?.ok) {
      setDialog(null);
      setReason("");
      router.refresh();
    }
  }
  const close = () => { if (!sub.pending) { setDialog(null); sub.clear(); } };

  return (
    <>
      {status === "draft" && canConfirm ? <Button onClick={() => setDialog("confirm")}><CircleCheck /> Confirm order</Button> : null}
      {(status === "draft" || status === "confirmed") && canCancel ? <Button variant="outline" onClick={() => setDialog("cancel")}><Ban /> Cancel order</Button> : null}

      <Modal open={dialog === "confirm"} onClose={close} title={`Confirm ${orderNumber}?`} description="Confirming locks the order's lines and lets work be released into production. It does not start any production by itself."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Not yet</Button><SubmitButton pending={sub.pending} pendingLabel="Confirming…" form="confirm-order">Confirm order</SubmitButton></>}>
        <form id="confirm-order" onSubmit={(e) => { e.preventDefault(); void submit("confirm"); }}><FormError message={sub.error} /></form>
      </Modal>

      <Modal open={dialog === "cancel"} onClose={close} title={`Cancel ${orderNumber}?`} description="A cancelled order can't be reopened. Linked production jobs must be cancelled first."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Keep order</Button><SubmitButton pending={sub.pending} pendingLabel="Cancelling…" variant="destructive" form="cancel-order">Cancel order</SubmitButton></>}>
        <form id="cancel-order" onSubmit={(e) => { e.preventDefault(); void submit("cancel"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>
    </>
  );
}

/** Releases ONE confirmed order line into production by creating its job through the normal job API. */
export function ReleaseLineButton({ line, branchId }: { line: { id: string; itemId: string; quantity: string; sku: string }; branchId: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);

  async function release() {
    const r = await sub.run(() => apiRequest<{ id: string }>("/api/v1/production-jobs", { method: "POST", body: { branchId, productItemId: line.itemId, plannedQty: Number(line.quantity), salesOrderLineId: line.id } }));
    if (r?.ok) {
      setOpen(false);
      router.push(`/production/jobs/${r.data.id}`);
      router.refresh();
    }
  }
  const close = () => { if (!sub.pending) { setOpen(false); sub.clear(); } };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Send /> Release to production</Button>
      <Modal open={open} onClose={close} title={`Release ${line.sku} to production?`} description={`Creates one production job for ${line.quantity} units, linked to this order line. The job starts as "planned" and still has to be released on the shop floor.`}
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Not yet</Button><SubmitButton pending={sub.pending} pendingLabel="Creating job…" form="release-line">Create job</SubmitButton></>}>
        <form id="release-line" onSubmit={(e) => { e.preventDefault(); void release(); }}><FormError message={sub.error} /></form>
      </Modal>
    </>
  );
}
