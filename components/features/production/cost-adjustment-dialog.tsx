"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Scale } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CurrencySelect, FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { Currency } from "@/lib/api-types";
import { formatMoney } from "@/lib/format";
import { parseDecimalInput, requireText } from "@/lib/validate";

// Corrects a FROZEN job cost. The snapshot is never edited: this adds a signed,
// reasoned, permanent line beside it. Idempotent (clientRequestId reused on
// retry) and confirmed before anything is sent.
export function CostAdjustmentDialog({ jobId, jobNumber, currencies }: { jobId: string; jobNumber: string; currencies: Currency[] }) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState("");
  const [component, setComponent] = useState<"labour" | "material">("labour");
  const [direction, setDirection] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ payload: Record<string, unknown>; summary: string } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  function close() {
    if (sub.pending) return;
    setOpen(false);
    setReview(null);
    sub.clear();
    setLocal({});
  }

  function onReview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!currency) problems.currency = "Choose the currency of the correction.";
    const a = parseDecimalInput(amount, { maxDecimals: 4, min: "positive", label: "Amount" });
    if (!a.ok) problems.amount = a.message;
    const r = requireText(reason, "Reason", { min: 10, max: 500 });
    if (r) problems.reason = r;
    setLocal(problems);
    if (Object.keys(problems).length || !a.ok) return sub.fail("Fix the highlighted fields and try again.");
    sub.clear();
    const signed = direction === "add" ? a.value : -a.value;
    setReview({
      payload: { currency, component, amount: signed, reason: reason.trim() },
      summary: `${direction === "add" ? "Add" : "Remove"} ${formatMoney(String(a.value), currency)} ${direction === "add" ? "to" : "from"} ${component} cost on ${jobNumber}.`,
    });
  }

  async function confirm() {
    if (!review) return;
    const prepared = idem.current.prepare(review.payload);
    if (!prepared.ok) {
      setReview(null);
      return sub.fail(prepared.reason);
    }
    const result = await sub.run(
      () => apiRequest(`/api/v1/production-jobs/${jobId}/cost-adjustments`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...review.payload } }),
      { idempotency: idem.current, visibleFields: ["currency", "amount", "reason"] },
    );
    if (!result) return;
    setReview(null);
    if (result.ok) {
      setOpen(false);
      setAmount("");
      setReason("");
      router.refresh();
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Scale /> Record adjustment
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        title={review ? "Confirm cost adjustment" : `Adjust the cost of ${jobNumber}`}
        description={review ? "This is permanent. It can be offset by another adjustment, never edited or deleted." : "The frozen cost is not changed. Your correction is recorded beside it, with your name and reason."}
        footer={
          review ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setReview(null)} disabled={sub.pending}>
                Back
              </Button>
              <Button type="button" onClick={confirm} disabled={sub.pending} aria-busy={sub.pending}>
                {sub.pending ? "Recording…" : "Record adjustment"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" form="cost-adjust-form">
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
          <form id="cost-adjust-form" onSubmit={onReview} noValidate className="space-y-4">
            <FormError message={sub.error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ca-component" label="Cost component" required>
                <Select id="ca-component" value={component} onChange={(e) => setComponent(e.target.value as "labour" | "material")}>
                  <option value="labour">Labour</option>
                  <option value="material">Material</option>
                </Select>
              </Field>
              <Field id="ca-currency" label="Currency" required error={errors.currency}>
                <CurrencySelect id="ca-currency" value={currency} onChange={setCurrency} currencies={currencies} invalid={Boolean(errors.currency)} describedBy={describedBy("ca-currency", { error: errors.currency })} />
              </Field>
            </div>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">Effect</legend>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="ca-direction" checked={direction === "add"} onChange={() => setDirection("add")} className="accent-[var(--primary)]" />
                  Increase cost
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="ca-direction" checked={direction === "remove"} onChange={() => setDirection("remove")} className="accent-[var(--primary)]" />
                  Decrease cost
                </label>
              </div>
            </fieldset>
            <Field id="ca-amount" label="Amount" required error={errors.amount} hint="Up to 4 decimal places. A decrease can't take a cost below zero.">
              <Input id="ca-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={Boolean(errors.amount) || undefined} aria-describedby={describedBy("ca-amount", { error: errors.amount, hint: "x" })} />
            </Field>
            <Field id="ca-reason" label="Reason" required error={errors.reason} hint="At least 10 characters. Shown to everyone who can see this job's cost.">
              <Textarea id="ca-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason) || undefined} aria-describedby={describedBy("ca-reason", { error: errors.reason, hint: "x" })} />
            </Field>
            <Notice tone="neutral">Use this for genuine corrections (a missed timesheet, a mis-priced issue). Normal issues and labour can no longer be posted to a completed job.</Notice>
          </form>
        )}
      </Modal>
    </>
  );
}
