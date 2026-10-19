"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { CurrencySelect, FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { LocalTime } from "@/components/ui/local-time";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { Currency } from "@/lib/api-types";
import { formatDecimal } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

interface Entry {
  id: string;
  hours: string;
  recordedAt: string;
  replayed: boolean;
}

// Records one labour entry. The rate is typed by the person recording (the
// backend has no rate card yet) and is stored with its own currency; whether it
// is shown back depends on cost access. There is no endpoint that lists labour
// records, so confirmations below are only those made in this browser session.
export function LabourForm({ jobId, currencies }: { jobId: string; currencies: Currency[] }) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [hours, setHours] = useState("");
  const [rate, setRate] = useState("");
  const [currency, setCurrency] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [entries, setEntries] = useState<Entry[]>([]);
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    const h = parseDecimalInput(hours, { maxDecimals: 2, min: "positive", label: "Hours" });
    if (!h.ok) problems.hours = h.message;
    else if (h.value > 24) problems.hours = "A single record can't exceed 24 hours.";
    const r = parseDecimalInput(rate, { maxDecimals: 4, min: "nonnegative", label: "Hourly rate" });
    if (!r.ok) problems.rate = r.message;
    if (!currency) problems.rateCurrency = "Choose the currency of the rate.";
    setLocal(problems);
    if (Object.keys(problems).length || !h.ok || !r.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { hours: h.value, rate: r.value, rateCurrency: currency };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(() => apiRequest<{ id: string; hours: string; recordedAt: string }>(`/api/v1/production-jobs/${jobId}/labour`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }), {
      idempotency: idem.current,
      visibleFields: ["hours", "rate", "rateCurrency"],
    });
    if (result?.ok) {
      setEntries((es) => [{ id: result.data.id, hours: String(result.data.hours), recordedAt: result.data.recordedAt, replayed: result.replayed }, ...es]);
      setHours("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-3">
          <FormError message={sub.error} />
        </div>
        <Field id="lab-hours" label="Hours worked" required error={errors.hours} hint="Up to 24, two decimals.">
          <Input id="lab-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} aria-invalid={Boolean(errors.hours) || undefined} aria-describedby={describedBy("lab-hours", { error: errors.hours, hint: "x" })} />
        </Field>
        <Field id="lab-rate" label="Hourly rate" required error={errors.rate}>
          <Input id="lab-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-invalid={Boolean(errors.rate) || undefined} aria-describedby={describedBy("lab-rate", { error: errors.rate })} />
        </Field>
        <Field id="lab-cur" label="Rate currency" required error={errors.rateCurrency}>
          <CurrencySelect id="lab-cur" value={currency} onChange={setCurrency} currencies={currencies} invalid={Boolean(errors.rateCurrency)} describedBy={describedBy("lab-cur", { error: errors.rateCurrency })} />
        </Field>
        <div className="sm:col-span-3">
          <SubmitButton pending={sub.pending} pendingLabel="Recording…">
            Record labour
          </SubmitButton>
        </div>
      </form>

      {entries.length > 0 ? (
        <section aria-label="Recorded in this session" className="space-y-2">
          <h3 className="text-sm font-semibold">Recorded in this session</h3>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                <span>
                  {formatDecimal(e.hours, { maxFraction: 2 })} h{e.replayed ? <span className="text-muted-foreground"> (already recorded; not duplicated)</span> : null}
                </span>
                <LocalTime iso={e.recordedAt} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <Notice tone="neutral">The labour list for a job isn&apos;t available from the server yet. Entries you record appear in the job&apos;s labour cost for roles with cost access.</Notice>
      )}
    </div>
  );
}
