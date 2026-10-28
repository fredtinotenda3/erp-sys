"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { requireText } from "@/lib/validate";

export function NewBranchForm() {
  const router = useRouter();
  const sub = useSubmission();
  const [name, setName] = useState("");
  const [local, setLocal] = useState<string | undefined>();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p = requireText(name, "Branch name", { max: 200 });
    setLocal(p ?? undefined);
    if (p) return sub.fail("Fix the highlighted field and try again.");
    const r = await sub.run(() => apiRequest<{ id: string }>("/api/v1/branches", { method: "POST", body: { name: name.trim() } }));
    if (r?.ok) { router.push(`/settings/branches/${r.data.id}`); router.refresh(); }
  }
  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <FormError message={sub.error} />
      <Field id="name" label="Branch name" required error={sub.fieldErrors.name ?? local}><Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></Field>
      <div className="flex gap-2">
        <SubmitButton pending={sub.pending} pendingLabel="Creating…">Create branch</SubmitButton>
        <Button type="button" variant="outline" disabled={sub.pending} onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}

export function DeactivateBranchButton({ branchId, name }: { branchId: string; name: string }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>Deactivate branch</Button>
      <Modal open={open} onClose={() => { if (!sub.pending) { setOpen(false); sub.clear(); } }} title={`Deactivate ${name}?`} description="Deactivated branches can't take new work. Existing records and history stay. There is no reactivate action yet, so this is not reversible from here."
        footer={<><Button variant="outline" disabled={sub.pending} onClick={() => setOpen(false)}>Keep active</Button><SubmitButton pending={sub.pending} pendingLabel="Deactivating…" variant="destructive" form="deactivate-branch">Deactivate</SubmitButton></>}>
        <form id="deactivate-branch" onSubmit={async (e) => { e.preventDefault(); const r = await sub.run(() => apiRequest(`/api/v1/branches/${branchId}`, { method: "PATCH", body: { isActive: false } })); if (r?.ok) { setOpen(false); router.refresh(); } }}><FormError message={sub.error} /></form>
      </Modal>
    </>
  );
}
