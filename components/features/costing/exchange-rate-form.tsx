"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { CurrencySelect, FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { Currency } from "@/lib/api-types";
import { formatDate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

const SOURCES = [
  ["RBZ_OFFICIAL", "RBZ official"],
  ["MARKET", "Market"],
  ["MANUAL", "Manual"],
] as const;

// Records one rate. Convention is stated on the form itself: 1 unit of BASE buys
// `rate` units of QUOTE. Rates are append-only: there is no edit; a correction is
// a new, later row, and costs already converted keep citing the row they used.
export function ExchangeRateForm({ currencies, today }: { currencies: Currency[]; today: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [base, setBase] = useState("");
  const [quote, setQuote] = useState("");
  const [rate, setRate] = useState("");
  const [asOf, setAsOf] = useState(today);
  const [source, setSource] = useState<(typeof SOURCES)[number][0]>("MANUAL");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [review, setReview] = useState<{ payload: Record<string, unknown>; summary: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  function onReview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!base) problems.baseCurrency = "Choose the base currency.";
    if (!quote) problems.quoteCurrency = "Choose the quote currency.";
    if (base && base === quote) problems.quoteCurrency = "Base and quote currencies must differ.";
    const r = parseDecimalInput(rate, { maxDecimals: 8, min: "positive", label: "Rate" });
    if (!r.ok) problems.rate = r.message;
    if (!asOf) problems.asOfDate = "Choose the date this rate applies from.";
    else if (asOf > today) problems.asOfDate = "The effective date can't be in the future.";
    setLocal(problems);
    if (Object.keys(problems).length || !r.ok) return sub.fail("Fix the highlighted fields and try again.");
    sub.clear();
    setReview({
      payload: { baseCurrency: base, quoteCurrency: quote, rate: r.value, asOfDate: asOf, source },
      summary: `1 ${base} = ${rate.trim()} ${quote}, effective ${formatDate(asOf)}, source ${SOURCES.find((s) => s[0] === source)![1]}.`,
    });
  }

  async function confirm() {
    if (!review) return;
    const result = await sub.run(() => apiRequest("/api/v1/exchange-rates", { method: "POST", body: review.payload }), { visibleFields: ["baseCurrency", "quoteCurrency", "rate", "asOfDate"] });
    if (!result) return;
    setReview(null);
    if (result.ok) {
      setDone(`Recorded: ${review.summary}`);
      setRate("");
      setUncertain(false);
      router.refresh();
    } else if (result.network || result.status >= 500) {
      setUncertain(true);
    }
  }

  return (
    <>
      <form onSubmit={onReview} noValidate className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-start">
        <div className="sm:col-span-2 lg:col-span-5 space-y-2">
          <FormError message={sub.error} />
          {done ? <Notice tone="success">{done}</Notice> : null}
          {uncertain ? <Notice tone="warning" title="Check before retrying">The server didn&apos;t confirm whether the rate was saved. Look at the history below before submitting again.</Notice> : null}
        </div>
        <Field id="fx-base" label="Base currency" required error={errors.baseCurrency} hint="The currency being priced.">
          <CurrencySelect id="fx-base" value={base} onChange={setBase} currencies={currencies} invalid={Boolean(errors.baseCurrency)} describedBy={describedBy("fx-base", { error: errors.baseCurrency, hint: "x" })} />
        </Field>
        <Field id="fx-quote" label="Quote currency" required error={errors.quoteCurrency} hint="What one base unit buys.">
          <CurrencySelect id="fx-quote" value={quote} onChange={setQuote} currencies={currencies} invalid={Boolean(errors.quoteCurrency)} describedBy={describedBy("fx-quote", { error: errors.quoteCurrency, hint: "x" })} />
        </Field>
        <Field id="fx-rate" label={base && quote ? `Rate (${quote} per 1 ${base})` : "Rate"} required error={errors.rate} hint="Greater than zero, up to 8 decimals.">
          <Input id="fx-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-invalid={Boolean(errors.rate) || undefined} aria-describedby={describedBy("fx-rate", { error: errors.rate, hint: "x" })} />
        </Field>
        <Field id="fx-date" label="Effective date" required error={errors.asOfDate}>
          <Input id="fx-date" type="date" max={today} value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-invalid={Boolean(errors.asOfDate) || undefined} aria-describedby={describedBy("fx-date", { error: errors.asOfDate })} />
        </Field>
        <Field id="fx-source" label="Source" required>
          <Select id="fx-source" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            {SOURCES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2 lg:col-span-5">
          <Button type="submit" disabled={sub.pending}>
            Review rate
          </Button>
        </div>
      </form>

      <Modal
        open={review !== null}
        onClose={() => !sub.pending && setReview(null)}
        dismissible={!sub.pending}
        size="sm"
        title="Record this exchange rate?"
        description="Rates are permanent. To correct one, record a new rate; the history is kept and costs already converted keep the rate they used."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setReview(null)} disabled={sub.pending}>
              Back
            </Button>
            <Button type="button" onClick={confirm} disabled={sub.pending} aria-busy={sub.pending}>
              {sub.pending ? "Recording…" : "Record rate"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <FormError message={sub.error} />
          <p className="font-medium">{review?.summary}</p>
        </div>
      </Modal>
    </>
  );
}
