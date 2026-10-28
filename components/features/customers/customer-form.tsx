"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { requireText } from "@/lib/validate";

// Create or edit a customer using exactly the fields the schema has: name, contact, address,
// notes, status. The server validates again and is authoritative.
export function CustomerForm({ customer }: { customer?: { id: string; name: string; status: "active" | "inactive"; contact?: string | null; address?: string | null; notes?: string | null } }) {
  const router = useRouter();
  const sub = useSubmission();
  const [name, setName] = useState(customer?.name ?? "");
  const [contact, setContact] = useState(customer?.contact ?? "");
  const [address, setAddress] = useState(customer?.address ?? "");
  const [notes, setNotes] = useState(customer?.notes ?? "");
  const [status, setStatus] = useState<"active" | "inactive">(customer?.status ?? "active");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const nameProblem = requireText(name, "Name", { max: 200 });
    setLocal(nameProblem ? { name: nameProblem } : {});
    if (nameProblem) return sub.fail("Fix the highlighted field and try again.");
    const problems: Record<string, string> = {};
    if (contact.length > 200) problems.contact = "Keep contact details under 200 characters.";
    if (address.length > 500) problems.address = "Keep the address under 500 characters.";
    if (notes.length > 2000) problems.notes = "Keep notes under 2000 characters.";
    if (Object.keys(problems).length) { setLocal(problems); return sub.fail("Fix the highlighted fields and try again."); }
    // On create, empty optional fields are omitted; on edit they are sent so a field can be cleared.
    const optional = customer
      ? { contact: contact.trim(), address: address.trim(), notes: notes.trim() }
      : { ...(contact.trim() ? { contact: contact.trim() } : {}), ...(address.trim() ? { address: address.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };
    const result = await sub.run(() =>
      customer
        ? apiRequest<{ id: string }>(`/api/v1/customers/${customer.id}`, { method: "PATCH", body: { name: name.trim(), status, ...optional } })
        : apiRequest<{ id: string }>("/api/v1/customers", { method: "POST", body: { name: name.trim(), ...optional } }),
    );
    if (result?.ok) {
      router.push(`/customers/${customer?.id ?? result.data.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <FormError message={sub.error} />
      <Field id="name" label="Customer name" required error={errors.name}>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-invalid={errors.name ? true : undefined} aria-describedby={describedBy("name", { error: errors.name })} />
      </Field>
      <Field id="contact" label="Contact" error={errors.contact}>
        <Input id="contact" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} aria-invalid={errors.contact ? true : undefined} aria-describedby={describedBy("contact", { error: errors.contact })} />
      </Field>
      <Field id="address" label="Address" error={errors.address}>
        <Textarea id="address" rows={2} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={500} aria-invalid={errors.address ? true : undefined} aria-describedby={describedBy("address", { error: errors.address })} />
      </Field>
      <Field id="notes" label="Notes" error={errors.notes}>
        <Textarea id="notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} aria-invalid={errors.notes ? true : undefined} aria-describedby={describedBy("notes", { error: errors.notes })} />
      </Field>
      {customer ? (
        <Field id="status" label="Status" hint="Inactive customers can't be chosen on new orders or jobs. Existing records are unaffected.">
          <Select id="status" value={status} onChange={(e) => setStatus(e.target.value as "active" | "inactive")}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </Field>
      ) : null}
      <div className="flex gap-2">
        <SubmitButton pending={sub.pending}>{customer ? "Save changes" : "Create customer"}</SubmitButton>
        <Button type="button" variant="outline" disabled={sub.pending} onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
