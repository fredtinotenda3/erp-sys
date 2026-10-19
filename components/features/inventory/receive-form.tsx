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

export interface ItemOption {
  id: string;
  label: string;
  uom: string;
}

// Purchase receipt: stock in, with the unit cost and ITS OWN currency. The
// server updates the weighted-average cost per currency; nothing is converted.
export function ReceiveForm({ items, warehouses, currencies }: { items: ItemOption[]; warehouses: { id: string; name: string }[]; currencies: Currency[] }) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [itemId, setItemId] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0]!.id : "");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("");
  const [note, setNote] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean; at: number } | null>(null);
  const onHand = useOnHand(itemId, warehouseId, done?.at ?? null);
  const item = items.find((i) => i.id === itemId);
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!itemId) problems.itemId = "Choose an item.";
    if (!warehouseId) problems.warehouseId = "Choose a warehouse.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    const c = parseDecimalInput(cost, { maxDecimals: 4, min: "nonnegative", label: "Unit cost" });
    if (!c.ok) problems.unitCost = c.message;
    if (!currency) problems.currency = "Choose the currency of the unit cost.";
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok || !c.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { warehouseId, itemId, quantity: q.value, unitCost: c.value, currency, ...(note.trim() ? { note: note.trim() } : {}) };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(() => apiRequest("/api/v1/stock/receipts", { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }), {
      idempotency: idem.current,
      visibleFields: ["itemId", "warehouseId", "quantity", "unitCost", "currency", "note"],
    });
    if (result?.ok) {
      setDone({ text: `Received ${formatQuantity(String(q.value), item?.uom)} of ${item?.label ?? "item"}.`, replayed: result.replayed, at: (done?.at ?? 0) + 1 });
      setQty("");
      setNote("");
      router.refresh();
    }
  }

  const stockHint = onHand.state === "ok" ? `On hand now: ${formatQuantity(onHand.quantity, item?.uom)}` : onHand.state === "error" ? "On-hand quantity couldn't be loaded." : undefined;

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <FormError message={sub.error} />
      {done ? (
        <Notice tone="success">
          {done.replayed ? "This receipt had already been recorded, so nothing new was posted. " : ""}
          {done.text}
        </Notice>
      ) : null}
      <Field id="rc-item" label="Item" required error={errors.itemId} hint="Raw materials, consumables and spare parts.">
        <Select id="rc-item" value={itemId} onChange={(e) => setItemId(e.target.value)} aria-invalid={Boolean(errors.itemId) || undefined} aria-describedby={describedBy("rc-item", { error: errors.itemId, hint: "x" })}>
          <option value="">Choose item…</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="rc-wh" label="Warehouse" required error={errors.warehouseId} hint={stockHint}>
        <Select id="rc-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-invalid={Boolean(errors.warehouseId) || undefined} aria-describedby={describedBy("rc-wh", { error: errors.warehouseId, hint: stockHint })}>
          <option value="">Choose warehouse…</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="rc-qty" label={`Quantity${item ? ` (${item.uom})` : ""}`} required error={errors.quantity}>
          <Input id="rc-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("rc-qty", { error: errors.quantity })} />
        </Field>
        <Field id="rc-cost" label="Unit cost" required error={errors.unitCost}>
          <Input id="rc-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-invalid={Boolean(errors.unitCost) || undefined} aria-describedby={describedBy("rc-cost", { error: errors.unitCost })} />
        </Field>
        <Field id="rc-cur" label="Currency" required error={errors.currency}>
          <CurrencySelect id="rc-cur" value={currency} onChange={setCurrency} currencies={currencies} invalid={Boolean(errors.currency)} describedBy={describedBy("rc-cur", { error: errors.currency })} />
        </Field>
      </div>
      <Field id="rc-note" label="Supplier or delivery-note reference" hint="Optional.">
        <Input id="rc-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <SubmitButton pending={sub.pending} pendingLabel="Recording…">
        Record receipt
      </SubmitButton>
    </form>
  );
}
