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

/** Add a mould. Mirrors machine-form.tsx's shape closely. */
export function MouldForm({
  branches,
  defaultBranchId,
  products,
}: {
  branches: { id: string; name: string }[];
  defaultBranchId?: string | null;
  products: { id: string; name: string; sku: string }[];
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [branchId, setBranchId] = useState(defaultBranchId ?? (branches.length === 1 ? branches[0]!.id : ""));
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [cavityCount, setCavityCount] = useState("1");
  const [productItemId, setProductItemId] = useState("");
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
    const cavities = Number(cavityCount);
    if (!Number.isInteger(cavities) || cavities <= 0) problems.cavityCount = "Cavity count must be a positive whole number.";
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");
    const result = await sub.run(
      () =>
        apiRequest("/api/v1/moulds", {
          method: "POST",
          body: { branchId, code: code.trim(), name: name.trim(), cavityCount: cavities, compatibleProductItemId: productItemId || undefined },
        }),
      { visibleFields: ["branchId", "code", "name", "cavityCount", "compatibleProductItemId"] },
    );
    if (result?.ok) {
      setCode("");
      setName("");
      setCavityCount("1");
      setProductItemId("");
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-start">
      <div className="sm:col-span-2 lg:col-span-5">
        <FormError message={sub.error} />
      </div>
      <Field id="mould-branch" label="Branch" required error={errors.branchId}>
        <Select id="mould-branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={Boolean(defaultBranchId)}>
          <option value="">Choose branch…</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </Select>
      </Field>
      <Field id="mould-code" label="Code" required error={errors.code}>
        <Input id="mould-code" value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={Boolean(errors.code) || undefined} aria-describedby={describedBy("mould-code", { error: errors.code })} />
      </Field>
      <Field id="mould-name" label="Name" required error={errors.name}>
        <Input id="mould-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={describedBy("mould-name", { error: errors.name })} />
      </Field>
      <Field id="mould-cavities" label="Cavity count" required error={errors.cavityCount}>
        <Input id="mould-cavities" type="number" min="1" step="1" value={cavityCount} onChange={(e) => setCavityCount(e.target.value)} />
      </Field>
      <Field id="mould-product" label="Product this mould is cut for" hint="Optional">
        <Select id="mould-product" value={productItemId} onChange={(e) => setProductItemId(e.target.value)}>
          <option value="">Not set yet</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>
          ))}
        </Select>
      </Field>
      <div className="sm:col-span-2 lg:col-span-5">
        <SubmitButton pending={sub.pending} pendingLabel="Adding…">Add mould</SubmitButton>
      </div>
    </form>
  );
}
