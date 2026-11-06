"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Scale } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput, requireText } from "@/lib/validate";

type Prepared = { payload: Record<string, unknown>; summary: string };

/**
 * A controlled correction to a batch's remaining quantity (e.g. a recount),
 * posted through the stock ledger (finished-goods-service.ts's adjustBatch).
 * A decrease is valued at the current average cost by the server; an
 * increase needs an existing cost basis for this item/warehouse to average
 * into (the server reports a clear error if there isn't one -- no cost input
 * is offered here, unlike the general stock AdjustForm, because a
 * finished-goods item's cost basis is meant to come only from WIP->FG
 * receipts and transfers, never a manually-entered figure).
 */
export function FgBatchAdjustActions({ batchId, batchNumber, remaining, uom }: { batchId: string; batchNumber: string; remaining: string; uom: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"increase" | "decrease">("decrease");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [pendingConfirm, setPendingConfirm] = useState<Prepared | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  function close() {
    if (sub.pending) return;
    setOpen(false);
    setPendingConfirm(null);
    sub.clear();
    setLocal({});
  }

  function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    if (direction === "decrease" && q.ok && q.value > Number(remaining)) problems.quantity = `Only ${formatQuantity(remaining, uom)} remains in this batch; it can't go negative.`;
    const reasonErr = requireText(reason, "Reason", { min: 3, max: 500 });
    if (reasonErr) problems.reason = reasonErr;
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");
    sub.clear();
    const signed = direction === "increase" ? q.value : -q.value;
    setPendingConfirm({
      payload: { quantity: signed, reason: reason.trim() },
      summary: `${direction === "increase" ? "Increase" : "Decrease"} batch ${batchNumber} by ${formatQuantity(String(q.value), uom)}.`,
    });
  }

  async function submit() {
    if (!pendingConfirm) return;
    const prepared = idem.current.prepare(pendingConfirm.payload);
    if (!prepared.ok) {
      setPendingConfirm(null);
      return sub.fail(prepared.reason);
    }
    const result = await sub.run(
      () => apiRequest(`/api/v1/inventory/finished-goods/${batchId}/adjust`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...pendingConfirm.payload } }),
      { idempotency: idem.current, visibleFields: ["quantity", "reason"] },
    );
    if (!result) return;
    setPendingConfirm(null);
    if (result.ok) {
      setDone(`${pendingConfirm.summary} Recorded.${result.replayed ? " (This adjustment had already been recorded.)" : ""}`);
      setQty("");
      setReason("");
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Scale /> Adjust quantity
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        title={`Adjust batch ${batchNumber}`}
        description="Writes a permanent ledger entry correcting this batch's remaining quantity (e.g. after a physical recount). It can be offset by another adjustment, but never edited or deleted."
      >
        <form onSubmit={review} noValidate className="space-y-4">
          <FormError message={sub.error} />
          {done ? <Notice tone="success">{done}</Notice> : null}
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Direction</legend>
            <div className="flex gap-4 text-sm">
              {(["decrease", "increase"] as const).map((d) => (
                <label key={d} className="flex items-center gap-2">
                  <input type="radio" name="fg-adjust-direction" checked={direction === d} onChange={() => setDirection(d)} className="accent-[var(--primary)]" />
                  {d === "decrease" ? "Decrease (write off / shrinkage)" : "Increase (found stock)"}
                </label>
              ))}
            </div>
          </fieldset>
          <Field id="fg-adj-qty" label={`Quantity to ${direction} (${uom})`} required error={errors.quantity} hint={direction === "decrease" ? `Remaining: ${formatQuantity(remaining, uom)}` : undefined}>
            <Input id="fg-adj-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("fg-adj-qty", { error: errors.quantity })} />
          </Field>
          <Field id="fg-adj-reason" label="Reason" required error={errors.reason} hint="Recorded permanently with your name. At least 3 characters.">
            <Textarea id="fg-adj-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason) || undefined} aria-describedby={describedBy("fg-adj-reason", { error: errors.reason, hint: "x" })} />
          </Field>
          <Button type="submit" disabled={sub.pending}>
            Review adjustment
          </Button>
        </form>
      </Modal>

      <Modal
        open={pendingConfirm !== null}
        onClose={() => !sub.pending && setPendingConfirm(null)}
        dismissible={!sub.pending}
        size="sm"
        title="Confirm finished-goods adjustment"
        description="This writes a permanent ledger entry."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setPendingConfirm(null)} disabled={sub.pending}>
              Back
            </Button>
            <Button type="button" onClick={submit} disabled={sub.pending} aria-busy={sub.pending} variant={direction === "decrease" ? "destructive" : "primary"}>
              {sub.pending ? "Recording…" : "Record adjustment"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <FormError message={sub.error} />
          <p className="font-medium">{pendingConfirm?.summary}</p>
          <p className="text-muted-foreground">Reason: {String(pendingConfirm?.payload.reason ?? "")}</p>
        </div>
      </Modal>
    </>
  );
}
