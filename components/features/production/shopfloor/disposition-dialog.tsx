"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import { DISPOSITION_LABELS } from "@/lib/labels";
import { parseDecimalInput, requireText } from "@/lib/validate";

// The authorised decision on rejected units. Confirmed before it is sent because
// scrap and rework move units in the output ledger and cannot be undone.
export function DispositionDialog({ jobId, inspectionId, openQty, uom }: { jobId: string; inspectionId: string; openQty: string; uom: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"scrap" | "rework" | "use_as_is">("rework");
  const [qty, setQty] = useState(openQty);
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ payload: Record<string, unknown>; summary: string } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  function close() {
    if (sub.pending) return;
    setOpen(false);
    setReview(null);
    sub.clear();
  }

  function onReview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.qty = q.message;
    else if (q.value > Number(openQty)) problems.qty = `Only ${openQty} ${uom} are still awaiting a decision.`;
    const r = requireText(reason, "Reason", { min: 5, max: 500 });
    if (r) problems.reason = r;
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");
    sub.clear();
    setReview({ payload: { kind, qty: q.value, reason: reason.trim() }, summary: `${DISPOSITION_LABELS[kind]}: ${q.value} ${uom}.` });
  }

  async function confirm() {
    if (!review) return;
    const prepared = idem.current.prepare(review.payload);
    if (!prepared.ok) {
      setReview(null);
      return sub.fail(prepared.reason);
    }
    const res = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/inspections/${inspectionId}/dispositions`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...review.payload } }), {
      idempotency: idem.current,
      visibleFields: ["qty", "reason"],
    });
    if (!res) return;
    setReview(null);
    if (res.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Decide
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        title={review ? "Confirm disposition" : `Decide on ${openQty} rejected ${uom}`}
        description={review ? "This is permanent and recorded under your name." : "Scrap and rework move units in the output record; use-as-is records a concession."}
        footer={
          review ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setReview(null)} disabled={sub.pending}>
                Back
              </Button>
              <Button type="button" variant={kind === "scrap" ? "destructive" : "primary"} onClick={confirm} disabled={sub.pending} aria-busy={sub.pending}>
                {sub.pending ? "Recording…" : "Record decision"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" form={`disp-${inspectionId}`}>
                Review
              </Button>
            </>
          )
        }
      >
        {review ? (
          <div className="space-y-3 text-sm">
            <FormError message={sub.error} />
            <p className="font-medium">{review.summary}</p>
            <p className="text-muted-foreground">Reason: {String(review.payload.reason)}</p>
          </div>
        ) : (
          <form id={`disp-${inspectionId}`} onSubmit={onReview} noValidate className="space-y-4">
            <FormError message={sub.error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`d-kind-${inspectionId}`} label="Decision" required>
                <Select id={`d-kind-${inspectionId}`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {Object.entries(DISPOSITION_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={`d-qty-${inspectionId}`} label={`Units (${uom})`} required error={errors.qty}>
                <Input id={`d-qty-${inspectionId}`} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.qty) || undefined} aria-describedby={describedBy(`d-qty-${inspectionId}`, { error: errors.qty })} />
              </Field>
            </div>
            <Field id={`d-reason-${inspectionId}`} label="Reason" required error={errors.reason} hint="At least 5 characters. Kept in the audit history.">
              <Textarea id={`d-reason-${inspectionId}`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason) || undefined} aria-describedby={describedBy(`d-reason-${inspectionId}`, { error: errors.reason, hint: "x" })} />
            </Field>
            {kind === "use_as_is" ? <Notice tone="warning">Use-as-is accepts the units despite the defect. Only do this with a documented concession.</Notice> : null}
          </form>
        )}
      </Modal>
    </>
  );
}
