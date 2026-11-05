"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, CircleCheck, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";

// Confirm / cancel / close a purchase order. All three are explicit,
// confirmed actions; the page only refreshes after the server reports
// success. Mirrors order-actions.tsx's OrderActions, with "close" added
// (a PO can be force-closed after partial receiving, which a sales order
// has no equivalent of).
export function PurchaseOrderActions({
  orderId,
  poNumber,
  status,
  canConfirm,
  canUpdate,
}: {
  orderId: string;
  poNumber: string;
  status: string;
  canConfirm: boolean;
  canUpdate: boolean;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [dialog, setDialog] = useState<"confirm" | "cancel" | "close" | null>(null);
  const [reason, setReason] = useState("");

  async function submit(kind: "confirm" | "cancel" | "close") {
    if ((kind === "cancel" || kind === "close") && reason.trim().length < 3) {
      return sub.fail("Say why in at least 3 characters.", { reason: "Say why in at least 3 characters." });
    }
    const r = await sub.run(() => apiRequest(`/api/v1/purchase-orders/${orderId}/${kind}`, { method: "POST", body: kind === "confirm" ? {} : { reason: reason.trim() } }));
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
      {(status === "draft" || status === "confirmed") && canUpdate ? <Button variant="outline" onClick={() => setDialog("cancel")}><Ban /> Cancel order</Button> : null}
      {(status === "confirmed" || status === "partially_received" || status === "received") && canUpdate ? <Button variant="outline" onClick={() => setDialog("close")}><Lock /> Close order</Button> : null}

      <Modal open={dialog === "confirm"} onClose={close} title={`Confirm ${poNumber}?`} description="Confirming locks the order's lines and allows goods to be received against it."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Not yet</Button><SubmitButton pending={sub.pending} pendingLabel="Confirming…" form="confirm-po">Confirm order</SubmitButton></>}>
        <form id="confirm-po" onSubmit={(e) => { e.preventDefault(); void submit("confirm"); }}><FormError message={sub.error} /></form>
      </Modal>

      <Modal open={dialog === "cancel"} onClose={close} title={`Cancel ${poNumber}?`} description="A cancelled order can't be reopened. Once anything has been received against it, it can no longer be cancelled outright -- close it instead."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Keep order</Button><SubmitButton pending={sub.pending} pendingLabel="Cancelling…" variant="destructive" form="cancel-po">Cancel order</SubmitButton></>}>
        <form id="cancel-po" onSubmit={(e) => { e.preventDefault(); void submit("cancel"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="cancel-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="cancel-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>

      <Modal open={dialog === "close"} onClose={close} title={`Close ${poNumber}?`} description="Closing marks this order as finished even though part of it was never delivered. It can't be reopened, and no more goods can be received against it."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Not yet</Button><SubmitButton pending={sub.pending} pendingLabel="Closing…" variant="destructive" form="close-po">Close order</SubmitButton></>}>
        <form id="close-po" onSubmit={(e) => { e.preventDefault(); void submit("close"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="close-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="close-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
