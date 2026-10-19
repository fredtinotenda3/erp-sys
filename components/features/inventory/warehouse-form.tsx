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

export function WarehouseForm({ branches, defaultBranchId }: { branches: { id: string; name: string }[]; defaultBranchId: string | null }) {
  const router = useRouter();
  const sub = useSubmission();
  const [branchId, setBranchId] = useState(defaultBranchId ?? (branches.length === 1 ? branches[0]!.id : ""));
  const [name, setName] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!branchId) problems.branchId = "Choose a branch.";
    const n = requireText(name, "Name", { max: 100 });
    if (n) problems.name = n;
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");
    const result = await sub.run(() => apiRequest("/api/v1/warehouses", { method: "POST", body: { branchId, name: name.trim() } }), { visibleFields: ["branchId", "name"] });
    if (result?.ok) {
      setName("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
      <div className="sm:col-span-3">
        <FormError message={sub.error} />
      </div>
      <Field id="wh-branch" label="Branch" required error={errors.branchId}>
        <Select id="wh-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-invalid={Boolean(errors.branchId) || undefined} aria-describedby={describedBy("wh-branch", { error: errors.branchId })}>
          <option value="">Choose branch…</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="wh-name" label="Warehouse name" required error={errors.name}>
        <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={describedBy("wh-name", { error: errors.name })} />
      </Field>
      <div className="sm:pt-[22px]">
        <SubmitButton pending={sub.pending} pendingLabel="Adding…">
          Add warehouse
        </SubmitButton>
      </div>
    </form>
  );
}
