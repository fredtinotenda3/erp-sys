"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { requireText, parseDecimalInput } from "@/lib/validate";

export function WorkCentreForm({ branches, defaultBranchId }: { branches: { id: string; name: string }[]; defaultBranchId: string | null }) {
  const router = useRouter();
  const sub = useSubmission();
  const [branchId, setBranchId] = useState(defaultBranchId ?? (branches.length === 1 ? branches[0]!.id : ""));
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [dailyCapacityMinutes, setDailyCapacityMinutes] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!branchId) problems.branchId = "Choose a branch.";
    const c = requireText(code, "Code", { max: 30 });
    if (c) problems.code = c;
    const n = requireText(name, "Name", { max: 100 });
    if (n) problems.name = n;
    let capacity: number | null = null;
    if (dailyCapacityMinutes.trim() !== "") {
      const parsed = parseDecimalInput(dailyCapacityMinutes, { maxDecimals: 0, min: "nonnegative", label: "Daily capacity" });
      if (!parsed.ok) problems.dailyCapacityMinutes = parsed.message;
      else capacity = parsed.value;
    }
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");
    const result = await sub.run(
      () => apiRequest("/api/v1/work-centres", { method: "POST", body: { branchId, code: code.trim(), name: name.trim(), dailyCapacityMinutes: capacity } }),
      { visibleFields: ["branchId", "code", "name", "dailyCapacityMinutes"] },
    );
    if (result?.ok) {
      setCode("");
      setName("");
      setDailyCapacityMinutes("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-start">
      <div className="sm:col-span-2 lg:col-span-5">
        <FormError message={sub.error} />
      </div>
      <Field id="wc-branch" label="Branch" required error={errors.branchId}>
        <Select id="wc-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-invalid={Boolean(errors.branchId) || undefined} aria-describedby={describedBy("wc-branch", { error: errors.branchId })}>
          <option value="">Choose branch…</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="wc-code" label="Code" required error={errors.code}>
        <Input id="wc-code" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={Boolean(errors.code) || undefined} aria-describedby={describedBy("wc-code", { error: errors.code })} />
      </Field>
      <Field id="wc-name" label="Name" required error={errors.name}>
        <Input id="wc-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={describedBy("wc-name", { error: errors.name })} />
      </Field>
      <Field id="wc-capacity" label="Daily capacity (min)" hint="Leave blank if unknown" error={errors.dailyCapacityMinutes}>
        <Input
          id="wc-capacity"
          inputMode="numeric"
          value={dailyCapacityMinutes}
          onChange={(e) => setDailyCapacityMinutes(e.target.value)}
          aria-invalid={Boolean(errors.dailyCapacityMinutes) || undefined}
          aria-describedby={describedBy("wc-capacity", { error: errors.dailyCapacityMinutes, hint: "Leave blank if unknown" })}
        />
      </Field>
      <div className="sm:pt-[22px]">
        <SubmitButton pending={sub.pending} pendingLabel="Adding…">
          Add work centre
        </SubmitButton>
      </div>
    </form>
  );
}
