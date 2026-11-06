"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { requireText } from "@/lib/validate";

// Adds one characteristic to an EXISTING inspection plan -- the single-row
// counterpart of InspectionPlanForm's "at least one characteristic" creation
// list, for a plan that's already in use. Same bounds validation as that
// form's rows (min/target/max are plain finite numbers, not the
// positive/4-decimal quantity-style fields elsewhere -- a tolerance can be
// negative, e.g. a temperature). The server re-validates everything;
// addCharacteristic (quality-plan-service.ts) is the authority.
export function AddCharacteristicForm({ planId }: { planId: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [name, setName] = useState("");
  const [uom, setUom] = useState("");
  const [minValue, setMinValue] = useState("");
  const [targetValue, setTargetValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [local, setLocal] = useState<{ name?: string; bounds?: string }>({});
  const [added, setAdded] = useState<string | null>(null);
  const errors = { name: sub.fieldErrors.name ?? local.name, bounds: local.bounds };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdded(null);
    const nameErr = requireText(name, "Name", { max: 100 });
    const min = minValue.trim() !== "" ? Number(minValue) : undefined;
    const max = maxValue.trim() !== "" ? Number(maxValue) : undefined;
    const target = targetValue.trim() !== "" ? Number(targetValue) : undefined;
    let boundsErr: string | undefined;
    if (minValue.trim() !== "" && !Number.isFinite(min)) boundsErr = "Min must be a number.";
    else if (maxValue.trim() !== "" && !Number.isFinite(max)) boundsErr = "Max must be a number.";
    else if (targetValue.trim() !== "" && !Number.isFinite(target)) boundsErr = "Target must be a number.";
    else if (min !== undefined && max !== undefined && min > max) boundsErr = "Min can't exceed max.";
    setLocal({ name: nameErr ?? undefined, bounds: boundsErr });
    if (nameErr || boundsErr) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { name: name.trim(), uom: uom.trim() || undefined, minValue: min, maxValue: max, targetValue: target };
    const result = await sub.run(() => apiRequest(`/api/v1/inspection-plans/${planId}/characteristics`, { method: "POST", body: payload }));
    if (result?.ok) {
      setAdded(name.trim());
      setName("");
      setUom("");
      setMinValue("");
      setTargetValue("");
      setMaxValue("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      <FormError message={sub.error} />
      {added ? <Notice tone="success">Added &quot;{added}&quot; to this plan.</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
        <Field id="ac-name" label="Characteristic" required error={errors.name}>
          <Input id="ac-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={describedBy("ac-name", { error: errors.name })} />
        </Field>
        <Field id="ac-uom" label="Unit">
          <Input id="ac-uom" value={uom} maxLength={20} onChange={(e) => setUom(e.target.value)} />
        </Field>
        <Field id="ac-min" label="Min">
          <Input id="ac-min" inputMode="decimal" value={minValue} onChange={(e) => setMinValue(e.target.value)} />
        </Field>
        <Field id="ac-target" label="Target">
          <Input id="ac-target" inputMode="decimal" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} />
        </Field>
        <Field id="ac-max" label="Max">
          <Input id="ac-max" inputMode="decimal" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} />
        </Field>
        <div className="sm:pt-5">
          <SubmitButton pending={sub.pending} pendingLabel="Adding…">
            Add
          </SubmitButton>
        </div>
      </div>
      {errors.bounds ? <p role="alert" className="text-xs text-destructive">{errors.bounds}</p> : null}
    </form>
  );
}
