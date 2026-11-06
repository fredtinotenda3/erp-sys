"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { requireText } from "@/lib/validate";

export function MachineForm({ workCentres, defaultWorkCentreId }: { workCentres: { id: string; name: string; code: string }[]; defaultWorkCentreId?: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [workCentreId, setWorkCentreId] = useState(defaultWorkCentreId ?? (workCentres.length === 1 ? workCentres[0]!.id : ""));
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!workCentreId) problems.workCentreId = "Choose a work centre.";
    const c = requireText(code, "Code", { max: 30 });
    if (c) problems.code = c;
    const n = requireText(name, "Name", { max: 100 });
    if (n) problems.name = n;
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");
    const result = await sub.run(
      () => apiRequest("/api/v1/machines", { method: "POST", body: { workCentreId, code: code.trim(), name: name.trim() } }),
      { visibleFields: ["workCentreId", "code", "name"] },
    );
    if (result?.ok) {
      setCode("");
      setName("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-start">
      <div className="sm:col-span-4">
        <FormError message={sub.error} />
      </div>
      <Field id="m-wc" label="Work centre" required error={errors.workCentreId}>
        <Select
          id="m-wc"
          value={workCentreId}
          onChange={(e) => setWorkCentreId(e.target.value)}
          disabled={Boolean(defaultWorkCentreId)}
          aria-invalid={Boolean(errors.workCentreId) || undefined}
          aria-describedby={describedBy("m-wc", { error: errors.workCentreId })}
        >
          <option value="">Choose work centre…</option>
          {workCentres.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.code})
            </option>
          ))}
        </Select>
      </Field>
      <Field id="m-code" label="Code" required error={errors.code}>
        <Input id="m-code" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={Boolean(errors.code) || undefined} aria-describedby={describedBy("m-code", { error: errors.code })} />
      </Field>
      <Field id="m-name" label="Name" required error={errors.name}>
        <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={describedBy("m-name", { error: errors.name })} />
      </Field>
      <div className="sm:pt-[22px]">
        <SubmitButton pending={sub.pending} pendingLabel="Adding…">
          Add machine
        </SubmitButton>
      </div>
    </form>
  );
}
