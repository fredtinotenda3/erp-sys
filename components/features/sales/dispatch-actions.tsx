"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck } from "lucide-react";

import { Button } from "../../ui/button";
import { Field } from "../../ui/field";
import { Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import { Textarea } from "../../ui/textarea";
import { FormError, SubmitButton } from "../shared/form-bits";
import { useSubmission } from "../shared/use-submission";
import { apiRequest } from "../../../lib/api-client";

/**
 * Records that a dispatch was received by the customer. Purely
 * informational -- see dispatch-service.ts's header for why this never
 * moves stock or changes the sales order's status, so there is nothing to
 * undo and no "unconfirm" action.
 */
export function ConfirmDeliveryAction({ dispatchId, dispatchNumber }: { dispatchId: string; dispatchNumber: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  const [receivedBy, setReceivedBy] = useState("");
  const [deliveryNotes, setDeliveryNotes] = useState("");

  async function confirm() {
    const r = await sub.run(() =>
      apiRequest(`/api/v1/dispatches/${dispatchId}/deliver`, {
        method: "POST",
        body: { receivedBy: receivedBy.trim() || undefined, deliveryNotes: deliveryNotes.trim() || undefined },
      }),
    );
    if (r?.ok) {
      setOpen(false);
      router.refresh();
    }
  }
  const close = () => { if (!sub.pending) { setOpen(false); sub.clear(); } };

  return (
    <>
      <Button onClick={() => setOpen(true)}><CircleCheck /> Confirm delivery</Button>
      <Modal
        open={open}
        onClose={close}
        title={`Confirm delivery of ${dispatchNumber}?`}
        description="Records that the customer received this shipment. It does not move any stock -- that already happened when the dispatch was created."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Not yet</Button><SubmitButton pending={sub.pending} pendingLabel="Recording…" form="confirm-delivery">Confirm delivery</SubmitButton></>}
      >
        <form id="confirm-delivery" onSubmit={(e) => { e.preventDefault(); void confirm(); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="received-by" label="Received by" hint="Optional -- the name on the signature, if any.">
            <Input id="received-by" value={receivedBy} maxLength={200} onChange={(e) => setReceivedBy(e.target.value)} />
          </Field>
          <Field id="delivery-notes" label="Notes" hint="Optional.">
            <Textarea id="delivery-notes" rows={2} value={deliveryNotes} maxLength={1000} onChange={(e) => setDeliveryNotes(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
