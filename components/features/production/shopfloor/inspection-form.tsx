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

// Records an inspection RESULT: how many units were inspected and how many were
// rejected, with the defect category. Inspectors record; they can't decide the
// fate of rejected units (that needs quality:approve, see DispositionDialog).
export function InspectionForm({ jobId, uom, stages }: { jobId: string; uom: string; stages: { id: string; label: string }[] }) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [stageId, setStageId] = useState(stages.length === 1 ? stages[0]!.id : "");
  const [inspected, setInspected] = useState("");
  const [rejected, setRejected] = useState("");
  const [defect, setDefect] = useState("");
  const [notes, setNotes] = useState("");
  const [evidence, setEvidence] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean; fail: boolean } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (stages.length > 0 && !stageId) problems.jobStageId = "Choose the stage.";
    const i = parseDecimalInput(inspected, { maxDecimals: 4, min: "positive", label: "Inspected quantity" });
    if (!i.ok) problems.inspectedQty = i.message;
    const r = rejected.trim() === "" ? ({ ok: true, value: 0 } as const) : parseDecimalInput(rejected, { maxDecimals: 4, min: "nonnegative", label: "Rejected quantity" });
    if (!r.ok) problems.rejectedQty = r.message;
    if (i.ok && r.ok && r.value > i.value) problems.rejectedQty = "Can't exceed the units inspected.";
    if (r.ok && r.value > 0 && !defect) problems.rejectReason = "Choose the defect category.";
    setLocal(problems);
    if (Object.keys(problems).length || !i.ok || !r.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = {
      ...(stageId ? { jobStageId: stageId } : {}),
      inspectedQty: i.value,
      rejectedQty: r.value,
      ...(r.value > 0 ? { rejectReason: defect } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(evidence.trim() ? { evidenceRef: evidence.trim() } : {}),
    };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);
    const res = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/inspections`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }), {
      idempotency: idem.current,
      visibleFields: ["jobStageId", "inspectedQty", "rejectedQty", "rejectReason"],
    });
    if (res?.ok) {
      setDone({ text: r.value > 0 ? `Recorded: ${r.value} of ${i.value} ${uom} rejected. A manager must decide what happens to them.` : `Recorded: ${i.value} ${uom} passed.`, replayed: res.replayed, fail: r.value > 0 });
      setInspected(""); setRejected(""); setDefect(""); setNotes(""); setEvidence("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormError message={sub.error} />
      {done ? <Notice tone={done.fail ? "warning" : "success"}>{done.replayed ? "This inspection had already been recorded. " : ""}{done.text}</Notice> : null}
      {stages.length > 0 ? (
        <Field id="in-stage" label="Stage" required error={errors.jobStageId}>
          <Select id="in-stage" value={stageId} onChange={(e) => setStageId(e.target.value)} aria-invalid={Boolean(errors.jobStageId) || undefined} aria-describedby={describedBy("in-stage", { error: errors.jobStageId })}>
            <option value="">Choose stage…</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="in-qty" label={`Units inspected (${uom})`} required error={errors.inspectedQty} hint="Only units already reported good can be inspected.">
          <Input id="in-qty" inputMode="decimal" value={inspected} onChange={(e) => setInspected(e.target.value)} aria-invalid={Boolean(errors.inspectedQty) || undefined} aria-describedby={describedBy("in-qty", { error: errors.inspectedQty, hint: "x" })} />
        </Field>
        <Field id="in-rej" label={`Units rejected (${uom})`} error={errors.rejectedQty} hint="Leave blank if everything passed.">
          <Input id="in-rej" inputMode="decimal" value={rejected} onChange={(e) => setRejected(e.target.value)} aria-invalid={Boolean(errors.rejectedQty) || undefined} aria-describedby={describedBy("in-rej", { error: errors.rejectedQty, hint: "x" })} />
        </Field>
      </div>
      <Field id="in-defect" label="Defect category" error={errors.rejectReason} hint="Required when units are rejected.">
        <Select id="in-defect" value={defect} onChange={(e) => setDefect(e.target.value)} aria-invalid={Boolean(errors.rejectReason) || undefined} aria-describedby={describedBy("in-defect", { error: errors.rejectReason, hint: "x" })}>
          <option value="">None</option>
          {REJECT_REASON_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="in-notes" label="Defect notes">
          <Textarea id="in-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Field id="in-evid" label="Evidence reference" hint="For example a photo or gauge-sheet number.">
          <Input id="in-evid" value={evidence} maxLength={500} onChange={(e) => setEvidence(e.target.value)} />
        </Field>
      </div>
      <SubmitButton pending={sub.pending} pendingLabel="Recording…">
        Record inspection
      </SubmitButton>
    </form>
  );
}
