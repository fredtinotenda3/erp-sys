"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { requireText } from "@/lib/validate";

interface CharRow {
  key: number;
  name: string;
  uom: string;
  minValue: string;
  targetValue: string;
  maxValue: string;
}

// A new inspection plan: a name plus at least one characteristic, each with
// optional min/target/max tolerances. Characteristics can be added to an
// existing plan later (see AddCharacteristicForm, below), but a plan can't
// be created empty -- createInspectionPlan requires at least one.
export function InspectionPlanForm({ itemId }: { itemId: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [name, setName] = useState("");
  const [nextKey, setNextKey] = useState(1);
  const [rows, setRows] = useState<CharRow[]>([{ key: 0, name: "", uom: "", minValue: "", targetValue: "", maxValue: "" }]);
  const [rowErrors, setRowErrors] = useState<Record<number, { name?: string; bounds?: string }>>({});

  function update(key: number, patch: Partial<CharRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nameErr = requireText(name, "Plan name", { max: 100 });
    const errs: Record<number, { name?: string; bounds?: string }> = {};
    const characteristics: { name: string; uom?: string; minValue?: number; maxValue?: number; targetValue?: number }[] = [];
    for (const r of rows) {
      const e1: { name?: string; bounds?: string } = {};
      const n = requireText(r.name, "Name", { max: 100 });
      if (n) e1.name = n;
      const min = r.minValue.trim() !== "" ? Number(r.minValue) : undefined;
      const max = r.maxValue.trim() !== "" ? Number(r.maxValue) : undefined;
      const target = r.targetValue.trim() !== "" ? Number(r.targetValue) : undefined;
      if (r.minValue.trim() !== "" && !Number.isFinite(min)) e1.bounds = "Min must be a number.";
      else if (r.maxValue.trim() !== "" && !Number.isFinite(max)) e1.bounds = "Max must be a number.";
      else if (r.targetValue.trim() !== "" && !Number.isFinite(target)) e1.bounds = "Target must be a number.";
      else if (min !== undefined && max !== undefined && min > max) e1.bounds = "Min can't exceed max.";
      if (Object.keys(e1).length) errs[r.key] = e1;
      else characteristics.push({ name: r.name.trim(), uom: r.uom.trim() || undefined, minValue: min, maxValue: max, targetValue: target });
    }
    setRowErrors(errs);
    if (nameErr || Object.keys(errs).length > 0) return sub.fail(nameErr ?? "Fix the highlighted characteristics and try again.");

    const result = await sub.run(() => apiRequest(`/api/v1/items/${itemId}/inspection-plans`, { method: "POST", body: { name: name.trim(), characteristics } }));
    if (result?.ok) {
      setName("");
      setRows([{ key: nextKey, name: "", uom: "", minValue: "", targetValue: "", maxValue: "" }]);
      setNextKey((k) => k + 1);
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormError message={sub.error} />
      <Field id="plan-name" label="Plan name" required error={sub.fieldErrors.name}>
        <Input id="plan-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(sub.fieldErrors.name) || undefined} aria-describedby={describedBy("plan-name", { error: sub.fieldErrors.name })} />
      </Field>

      <ul className="space-y-3">
        {rows.map((r, idx) => {
          const err = rowErrors[r.key] ?? {};
          return (
            <li key={r.key} className="rounded-lg border border-border bg-card p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
                <div className="space-y-1">
                  <label htmlFor={`cn-${r.key}`} className="text-xs font-medium text-muted-foreground">Characteristic {idx + 1}</label>
                  <Input id={`cn-${r.key}`} value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} aria-invalid={Boolean(err.name) || undefined} />
                  {err.name ? <p role="alert" className="text-xs text-destructive">{err.name}</p> : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={`cu-${r.key}`} className="text-xs font-medium text-muted-foreground">Unit</label>
                  <Input id={`cu-${r.key}`} value={r.uom} onChange={(e) => update(r.key, { uom: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`cmin-${r.key}`} className="text-xs font-medium text-muted-foreground">Min</label>
                  <Input id={`cmin-${r.key}`} inputMode="decimal" value={r.minValue} onChange={(e) => update(r.key, { minValue: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`ctarget-${r.key}`} className="text-xs font-medium text-muted-foreground">Target</label>
                  <Input id={`ctarget-${r.key}`} inputMode="decimal" value={r.targetValue} onChange={(e) => update(r.key, { targetValue: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <label htmlFor={`cmax-${r.key}`} className="text-xs font-medium text-muted-foreground">Max</label>
                  <Input id={`cmax-${r.key}`} inputMode="decimal" value={r.maxValue} onChange={(e) => update(r.key, { maxValue: e.target.value })} />
                </div>
                <div className="sm:pt-5">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove characteristic ${idx + 1}`} disabled={rows.length === 1 || sub.pending} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {err.bounds ? <p role="alert" className="mt-2 text-xs text-destructive">{err.bounds}</p> : null}
            </li>
          );
        })}
      </ul>

      <Button
        type="button"
        variant="outline"
        disabled={sub.pending || rows.length >= 100}
        onClick={() => {
          setRows((rs) => [...rs, { key: nextKey, name: "", uom: "", minValue: "", targetValue: "", maxValue: "" }]);
          setNextKey((k) => k + 1);
        }}
      >
        <Plus /> Add characteristic
      </Button>

      <div className="border-t border-border pt-4">
        <SubmitButton pending={sub.pending} pendingLabel="Creating…">
          Create plan
        </SubmitButton>
      </div>
    </form>
  );
}
