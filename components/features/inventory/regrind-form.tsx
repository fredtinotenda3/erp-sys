"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { CurrencySelect, FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { useOnHand } from "./use-on-hand";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { Currency } from "@/lib/api-types";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

export interface RegrindMaterialOption {
  id: string;
  name: string;
  sku: string;
  uom: string;
}

// Records regrind generated from this job's scrap: a positive stock
// movement (movement_type = regrind_generation) into the job's branch,
// weighed and costed by the operator -- see regrind-service.ts's header for
// why the quantity is never derived from the job's recorded scrap output.
// Same shape as ReceiveForm (item/warehouse/quantity/unitCost/currency),
// because this is also a positive movement that needs a real cost basis,
// but posts to the job-scoped regrind endpoint instead of a plain receipt.
export function RegrindForm({
  jobId,
  materials,
  warehouses,
  currencies,
}: {
  jobId: string;
  materials: RegrindMaterialOption[];
  warehouses: { id: string; name: string }[];
  currencies: Currency[];
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [itemId, setItemId] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0]!.id : "");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("");
  const [notes, setNotes] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean; at: number } | null>(null);
  const onHand = useOnHand(itemId, warehouseId, done?.at ?? null);
  const material = materials.find((m) => m.id === itemId);
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!itemId) problems.itemId = "Choose a material.";
    if (!warehouseId) problems.warehouseId = "Choose a warehouse.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    const c = parseDecimalInput(cost, { maxDecimals: 4, min: "positive", label: "Unit cost" });
    if (!c.ok) problems.unitCost = c.message;
    if (!currency) problems.currency = "Choose the currency of the unit cost.";
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok || !c.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { itemId, warehouseId, quantity: q.value, unitCost: c.value, currency, ...(notes.trim() ? { notes: notes.trim() } : {}) };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    // The route always reads the job from the URL and stamps it onto
    // sourceJobId itself, so it's deliberately not sent in the body here.
    const result = await sub.run(
      () =>
        apiRequest<{ replayed: boolean }>(`/api/v1/production-jobs/${jobId}/regrind`, {
          method: "POST",
          body: { clientRequestId: prepared.clientRequestId, ...payload },
        }),
      { idempotency: idem.current, visibleFields: ["itemId", "warehouseId", "quantity", "unitCost", "currency", "notes"] },
    );
    if (result?.ok) {
      // This endpoint nests replayed inside `data` rather than promoting it
      // to the envelope (unlike /api/v1/stock/receipts) -- read it from there.
      setDone({ text: `Recorded ${formatQuantity(String(q.value), material?.uom)} of ${material?.name ?? "material"} as regrind.`, replayed: result.data.replayed, at: (done?.at ?? 0) + 1 });
      setQty("");
      setNotes("");
      router.refresh();
    }
  }

  const stockHint = onHand.state === "ok" ? `On hand now: ${formatQuantity(onHand.quantity, material?.uom)}` : onHand.state === "error" ? "On-hand quantity couldn't be loaded." : undefined;

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <FormError message={sub.error} />
      {done ? (
        <Notice tone="success">
          {done.replayed ? "This regrind had already been recorded, so nothing new was posted. " : ""}
          {done.text}
        </Notice>
      ) : null}
      <Field id="rg-item" label="Material" required error={errors.itemId}>
        <Select id="rg-item" value={itemId} onChange={(e) => setItemId(e.target.value)} aria-invalid={Boolean(errors.itemId) || undefined} aria-describedby={describedBy("rg-item", { error: errors.itemId })}>
          <option value="">Choose material…</option>
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.sku})
            </option>
          ))}
        </Select>
      </Field>
      <Field id="rg-wh" label="Warehouse" required error={errors.warehouseId} hint={stockHint}>
        <Select id="rg-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-invalid={Boolean(errors.warehouseId) || undefined} aria-describedby={describedBy("rg-wh", { error: errors.warehouseId, hint: stockHint })}>
          <option value="">Choose warehouse…</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="rg-qty" label={`Quantity${material ? ` (${material.uom})` : ""}`} required error={errors.quantity} hint="The weighed regrind output, not the job's recorded scrap quantity.">
          <Input id="rg-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("rg-qty", { error: errors.quantity, hint: "x" })} />
        </Field>
        <Field id="rg-cost" label="Unit cost" required error={errors.unitCost} hint="The value of the ground material, not a purchase price.">
          <Input id="rg-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-invalid={Boolean(errors.unitCost) || undefined} aria-describedby={describedBy("rg-cost", { error: errors.unitCost, hint: "x" })} />
        </Field>
        <Field id="rg-cur" label="Currency" required error={errors.currency}>
          <CurrencySelect id="rg-cur" value={currency} onChange={setCurrency} currencies={currencies} invalid={Boolean(errors.currency)} describedBy={describedBy("rg-cur", { error: errors.currency })} />
        </Field>
      </div>
      <Field id="rg-notes" label="Notes" hint="Optional.">
        <Input id="rg-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <SubmitButton pending={sub.pending} pendingLabel="Recording…">
        Record regrind
      </SubmitButton>
    </form>
  );
}
