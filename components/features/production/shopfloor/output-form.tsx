"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import { REJECT_REASON_OPTIONS } from "@/lib/labels";
import { parseDecimalInput } from "@/lib/validate";

// Records one production activity entry. Quantities are in the product's unit
// (shown, not chosen). The same clientRequestId is reused on retry so a double
// click or a dropped connection can't record the entry twice.
export function OutputForm({ jobId, uom, stages }: { jobId: string; uom: string; stages: { id: string; label: string }[] }) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [stageId, setStageId] = useState(stages.length === 1 ? stages[0]!.id : "");
  const [good, setGood] = useState("");
  const [scrap, setScrap] = useState("");
  const [rework, setRework] = useState("");
  const [reworkGood, setReworkGood] = useState("");
  const [reworkScrap, setReworkScrap] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    const num = (raw: string, key: string, label: string) => {
      if (raw.trim() === "") return 0;
      const r = parseDecimalInput(raw, { maxDecimals: 4, min: "nonnegative", label });
      if (!r.ok) problems[key] = r.message;
      return r.ok ? r.value : 0;
    };
    const g = num(good, "goodQty", "Good quantity");
    const s = num(scrap, "scrapQty", "Scrap quantity");
    const w = num(rework, "reworkQty", "Rework quantity");
    const rg = num(reworkGood, "reworkGoodQty", "Back from rework");
    const rs = num(reworkScrap, "reworkScrapQty", "Scrapped from rework");
    if (stages.length > 0 && !stageId) problems.jobStageId = "Choose the stage.";
    if (!problems.goodQty && g + s + w <= 0) problems.goodQty = "Enter at least one good, scrap or rework unit.";
    if ((s > 0 || w > 0) && !reason) problems.reason = "Choose a reason for the scrap or rework.";
    if (rg > g) problems.reworkGoodQty = "Can't exceed the good units in this entry.";
    if (rs > s) problems.reworkScrapQty = "Can't exceed the scrap units in this entry.";
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");

    const payload = {
      ...(stageId ? { jobStageId: stageId } : {}),
      goodQty: g, scrapQty: s, reworkQty: w, reworkGoodQty: rg, reworkScrapQty: rs,
      ...(reason ? { reason } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);
    const res = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/output`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }), {
      idempotency: idem.current,
      visibleFields: ["jobStageId", "goodQty", "scrapQty", "reworkQty", "reworkGoodQty", "reworkScrapQty", "reason"],
    });
    if (res?.ok) {
      setDone({ text: `Recorded ${g} good, ${s} scrap, ${w} rework (${uom}).`, replayed: res.replayed });
      setGood(""); setScrap(""); setRework(""); setReworkGood(""); setReworkScrap(""); setNotes("");
      router.refresh();
    }
  }

  const qtyField = (id: string, key: string, label: string, value: string, set: (v: string) => void, hint?: string) => (
    <Field id={id} label={`${label} (${uom})`} error={errors[key]} hint={hint}>
      <Input id={id} inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} aria-invalid={Boolean(errors[key]) || undefined} aria-describedby={describedBy(id, { error: errors[key], hint })} />
    </Field>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormError message={sub.error} />
      {done ? <Notice tone="success">{done.replayed ? "This entry had already been recorded, so nothing new was posted. " : ""}{done.text}</Notice> : null}
      {stages.length > 0 ? (
        <Field id="out-stage" label="Stage" required error={errors.jobStageId}>
          <Select id="out-stage" value={stageId} onChange={(e) => setStageId(e.target.value)} aria-invalid={Boolean(errors.jobStageId) || undefined} aria-describedby={describedBy("out-stage", { error: errors.jobStageId })}>
            <option value="">Choose stage…</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        {qtyField("out-good", "goodQty", "Good", good, setGood)}
        {qtyField("out-scrap", "scrapQty", "Scrap", scrap, setScrap)}
        {qtyField("out-rework", "reworkQty", "Sent to rework", rework, setRework)}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {qtyField("out-rg", "reworkGoodQty", "Back from rework", reworkGood, setReworkGood, "Part of the good units above that were reworked.")}
        {qtyField("out-rs", "reworkScrapQty", "Scrapped after rework", reworkScrap, setReworkScrap, "Part of the scrap above that had been reworked.")}
      </div>
      <Field id="out-reason" label="Reason for scrap / rework" error={errors.reason} hint="Required when scrap or rework is recorded.">
        <Select id="out-reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason) || undefined} aria-describedby={describedBy("out-reason", { error: errors.reason, hint: "x" })}>
          <option value="">None</option>
          {REJECT_REASON_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="out-notes" label="Notes">
        <Textarea id="out-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <SubmitButton pending={sub.pending} pendingLabel="Recording…">
        Record output
      </SubmitButton>
    </form>
  );
}
