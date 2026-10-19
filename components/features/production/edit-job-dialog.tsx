"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Modal } from "@/components/ui/modal";
import { CurrencySelect, FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { Currency, Job } from "@/lib/api-types";
import { parseDecimalInput } from "@/lib/validate";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

// Product, quantity and BOM are deliberately not editable after creation (the
// server rejects them), so this dialog only offers schedule, customer and quote.
export function EditJobDialog({
  job,
  customers,
  currencies,
  canSeeCost,
}: {
  job: Job;
  customers: { id: string; name: string }[] | null;
  currencies: Currency[];
  canSeeCost: boolean;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(day(job.plannedStart));
  const [end, setEnd] = useState(day(job.plannedEnd));
  const [customerId, setCustomerId] = useState(job.customerId ?? "");
  const [quote, setQuote] = useState(job.quotedAmount ?? "");
  const [quoteCurrency, setQuoteCurrency] = useState(job.quotedCurrency ?? "");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  function close() {
    if (sub.pending) return;
    setOpen(false);
    sub.clear();
    setLocal({});
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    if (start !== day(job.plannedStart)) body.plannedStart = start || null;
    if (end !== day(job.plannedEnd)) body.plannedEnd = end || null;
    if (start && end && end < start) problems.plannedEnd = "The planned end can't be before the planned start.";
    if (customers && customerId !== (job.customerId ?? "")) body.customerId = customerId || null;
    if (canSeeCost && (quote !== (job.quotedAmount ?? "") || quoteCurrency !== (job.quotedCurrency ?? ""))) {
      if (String(quote).trim() === "" && !quoteCurrency) {
        body.quotedAmount = null;
        body.quotedCurrency = null;
      } else {
        const a = parseDecimalInput(String(quote), { maxDecimals: 4, min: "nonnegative", label: "Quoted amount" });
        if (!a.ok) problems.quotedAmount = a.message;
        else if (!quoteCurrency) problems.quotedCurrency = "Choose the currency of the quote.";
        else {
          body.quotedAmount = a.value;
          body.quotedCurrency = quoteCurrency;
        }
      }
    }
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");
    if (Object.keys(body).length === 0) return sub.fail("Nothing has changed.");
    const result = await sub.run(() => apiRequest(`/api/v1/production-jobs/${job.id}`, { method: "PATCH", body }), {
      visibleFields: ["plannedStart", "plannedEnd", "quotedAmount", "quotedCurrency"],
    });
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Pencil /> Edit schedule
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        title={`Edit ${job.jobNumber}`}
        description="Product, quantity and BOM can't change after a job is created."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close} disabled={sub.pending}>
              Cancel
            </Button>
            <SubmitButton form="edit-job-form" pending={sub.pending}>
              Save changes
            </SubmitButton>
          </>
        }
      >
        <form id="edit-job-form" onSubmit={onSubmit} noValidate className="space-y-4">
          <FormError message={sub.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ej-start" label="Planned start" error={errors.plannedStart}>
              <Input id="ej-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field id="ej-end" label="Planned end" error={errors.plannedEnd}>
              <Input id="ej-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} aria-invalid={Boolean(errors.plannedEnd) || undefined} aria-describedby={describedBy("ej-end", { error: errors.plannedEnd })} />
            </Field>
          </div>
          {customers ? (
            <Field id="ej-cust" label="Customer">
              <Select id="ej-cust" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">No customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {canSeeCost ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="ej-quote" label="Quoted amount" error={errors.quotedAmount} hint="Clear both fields to remove the quote.">
                <Input id="ej-quote" inputMode="decimal" value={quote} onChange={(e) => setQuote(e.target.value)} aria-invalid={Boolean(errors.quotedAmount) || undefined} aria-describedby={describedBy("ej-quote", { error: errors.quotedAmount, hint: "x" })} />
              </Field>
              <Field id="ej-quotec" label="Quote currency" error={errors.quotedCurrency}>
                <CurrencySelect id="ej-quotec" value={quoteCurrency} onChange={setQuoteCurrency} currencies={currencies} invalid={Boolean(errors.quotedCurrency)} describedBy={describedBy("ej-quotec", { error: errors.quotedCurrency })} />
              </Field>
            </div>
          ) : null}
        </form>
      </Modal>
    </>
  );
}
