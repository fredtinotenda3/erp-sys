"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, CircleCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";

// Manual active<->quarantined transition for one lot (e.g. a supplier recall,
// or releasing a lot after a quality hold clears). Mirrors
// purchase-order-actions.tsx's confirm/cancel pattern. "expired" is not
// offered as a target here -- see lot-service.ts's setLotStatus for why.
export function LotStatusActions({ lotId, lotNumber, status }: { lotId: string; lotNumber: string; status: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [dialog, setDialog] = useState<"quarantine" | "release" | null>(null);
  const [reason, setReason] = useState("");

  async function submit(kind: "quarantine" | "release") {
    if (reason.trim().length < 3) return sub.fail("Say why in at least 3 characters.", { reason: "Say why in at least 3 characters." });
    const r = await sub.run(() =>
      apiRequest(`/api/v1/inventory/lots/${lotId}/status`, { method: "POST", body: { status: kind === "quarantine" ? "quarantined" : "active", reason: reason.trim() } }),
    );
    if (r?.ok) {
      setDialog(null);
      setReason("");
      router.refresh();
    }
  }
  const close = () => { if (!sub.pending) { setDialog(null); sub.clear(); } };

  if (status === "expired") return null;

  return (
    <>
      {status === "active" ? <Button variant="outline" onClick={() => setDialog("quarantine")}><Ban /> Quarantine lot</Button> : null}
      {status === "quarantined" ? <Button variant="outline" onClick={() => setDialog("release")}><CircleCheck /> Release to active</Button> : null}

      <Modal
        open={dialog === "quarantine"}
        onClose={close}
        title={`Quarantine lot ${lotNumber}?`}
        description="A quarantined lot can't be issued to any job until it's released back to active."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Not yet</Button><SubmitButton pending={sub.pending} pendingLabel="Quarantining…" variant="destructive" form="quarantine-lot">Quarantine lot</SubmitButton></>}
      >
        <form id="quarantine-lot" onSubmit={(e) => { e.preventDefault(); void submit("quarantine"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="quarantine-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="quarantine-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === "release"}
        onClose={close}
        title={`Release lot ${lotNumber} to active?`}
        description="This makes the lot available to issue to jobs again."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Not yet</Button><SubmitButton pending={sub.pending} pendingLabel="Releasing…" form="release-lot">Release lot</SubmitButton></>}
      >
        <form id="release-lot" onSubmit={(e) => { e.preventDefault(); void submit("release"); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="release-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="release-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
