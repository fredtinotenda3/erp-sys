"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CurrencySelect, FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { Currency } from "@/lib/api-types";
import { formatMoney } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

interface LineState { key: number; itemId: string; quantity: string; unitPrice: string }
export interface OrderFormOrder {
  id: string;
  branchId: string;
  customerId: string;
  currency: string;
  requestedDeliveryDate: string | null;
  lines: { itemId: string; quantity: string; unitPrice: string }[];
}

// Creates or edits a DRAFT order. Totals shown here are a convenience (quantity x price); the
// server computes the authoritative figure. Saving never releases work into production.
export function OrderForm({
  branches,
  customers,
  products,
  currencies,
  defaultBranchId,
  order,
}: {
  branches: { id: string; name: string }[];
  customers: { id: string; name: string }[];
  products: { id: string; name: string; sku: string; uom: string }[];
  currencies: Currency[];
  defaultBranchId: string | null;
  order?: OrderFormOrder;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [branchId, setBranchId] = useState(order?.branchId ?? defaultBranchId ?? (branches.length === 1 ? branches[0]!.id : ""));
  const [customerId, setCustomerId] = useState(order?.customerId ?? "");
  const [currency, setCurrency] = useState(order?.currency ?? "");
  const [delivery, setDelivery] = useState(order?.requestedDeliveryDate ?? "");
  const [nextKey, setNextKey] = useState(100);
  const [lines, setLines] = useState<LineState[]>(
    order ? order.lines.map((l, i) => ({ key: i, itemId: l.itemId, quantity: l.quantity, unitPrice: l.unitPrice })) : [{ key: 0, itemId: "", quantity: "", unitPrice: "" }],
  );
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  const setLine = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const total = lines.reduce((t, l) => {
    const q = parseDecimalInput(l.quantity, { maxDecimals: 4, min: "positive" });
    const p = parseDecimalInput(l.unitPrice, { maxDecimals: 4, min: "nonnegative" });
    return q.ok && p.ok ? t + q.value * p.value : t;
  }, 0);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!order && !branchId) problems.branchId = "Choose a branch.";
    if (!customerId) problems.customerId = "Choose a customer.";
    if (!order && !currency) problems.currency = "Choose a currency.";
    if (delivery && !/^\d{4}-\d{2}-\d{2}$/.test(delivery)) problems.requestedDeliveryDate = "Use a valid date.";
    const payloadLines: { itemId: string; quantity: number; unitPrice: number }[] = [];
    lines.forEach((l, i) => {
      if (!l.itemId) problems[`line${i}.itemId`] = "Choose a product.";
      const q = parseDecimalInput(l.quantity, { maxDecimals: 4, min: "positive", label: "Quantity" });
      const p = parseDecimalInput(l.unitPrice, { maxDecimals: 4, min: "nonnegative", label: "Unit price" });
      if (!q.ok) problems[`line${i}.quantity`] = q.message;
      if (!p.ok) problems[`line${i}.unitPrice`] = p.message;
      if (l.itemId && q.ok && p.ok) payloadLines.push({ itemId: l.itemId, quantity: q.value, unitPrice: p.value });
    });
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");

    const result = await sub.run(() =>
      order
        ? apiRequest<{ id: string }>(`/api/v1/sales-orders/${order.id}`, { method: "PATCH", body: { customerId, requestedDeliveryDate: delivery || null, lines: payloadLines } })
        : apiRequest<{ id: string }>("/api/v1/sales-orders", { method: "POST", body: { branchId, customerId, currency, ...(delivery ? { requestedDeliveryDate: delivery } : {}), lines: payloadLines } }),
    );
    if (result?.ok) {
      router.push(`/orders/${order?.id ?? result.data.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-4xl space-y-5">
      <FormError message={sub.error} />
      <Card className="grid gap-4 p-4 sm:grid-cols-2">
        <Field id="branchId" label="Branch" required error={errors.branchId}>
          <Select id="branchId" value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={Boolean(order)} aria-invalid={errors.branchId ? true : undefined}>
            <option value="">Choose a branch…</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field id="customerId" label="Customer" required error={errors.customerId}>
          <Select id="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-invalid={errors.customerId ? true : undefined}>
            <option value="">Choose a customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field id="currency" label="Currency" required error={errors.currency} hint={order ? "The currency is fixed once the order exists." : "Every line on the order uses this currency."}>
          <CurrencySelect id="currency" value={currency} onChange={setCurrency} currencies={currencies} invalid={Boolean(errors.currency)} disabled={Boolean(order)} />
        </Field>
        <Field id="requestedDeliveryDate" label="Requested delivery date" error={errors.requestedDeliveryDate}>
          <Input id="requestedDeliveryDate" type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} aria-describedby={describedBy("requestedDeliveryDate", { error: errors.requestedDeliveryDate })} />
        </Field>
      </Card>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold">Order lines</legend>
        {products.length === 0 ? <p className="text-sm text-muted-foreground">There are no active finished-good products to order yet. Create one in Products &amp; BOM first.</p> : null}
        {lines.map((l, i) => (
          <Card key={l.key} className="grid gap-3 p-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-start">
            <Field id={`item-${l.key}`} label="Product" error={errors[`line${i}.itemId`]}>
              <Select id={`item-${l.key}`} value={l.itemId} onChange={(e) => setLine(l.key, { itemId: e.target.value })} aria-invalid={errors[`line${i}.itemId`] ? true : undefined}>
                <option value="">Choose a product…</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
              </Select>
            </Field>
            <Field id={`qty-${l.key}`} label={`Quantity${products.find((p) => p.id === l.itemId) ? ` (${products.find((p) => p.id === l.itemId)!.uom})` : ""}`} error={errors[`line${i}.quantity`]}>
              <Input id={`qty-${l.key}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} aria-invalid={errors[`line${i}.quantity`] ? true : undefined} />
            </Field>
            <Field id={`price-${l.key}`} label="Unit price" error={errors[`line${i}.unitPrice`]}>
              <Input id={`price-${l.key}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(l.key, { unitPrice: e.target.value })} aria-invalid={errors[`line${i}.unitPrice`] ? true : undefined} />
            </Field>
            <Button type="button" variant="outline" size="icon" className="sm:mt-6" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
              <Trash2 />
            </Button>
          </Card>
        ))}
        <Button type="button" variant="outline" onClick={() => { setLines((ls) => [...ls, { key: nextKey, itemId: "", quantity: "", unitPrice: "" }]); setNextKey((k) => k + 1); }}>
          <Plus /> Add line
        </Button>
      </fieldset>

      <p className="text-sm" aria-live="polite">
        Order total (quantity × price, no tax or discounts): <strong>{currency ? formatMoney(String(total), currency) : total.toFixed(2)}</strong>
      </p>
      <div className="flex gap-2">
        <SubmitButton pending={sub.pending}>{order ? "Save draft" : "Create draft order"}</SubmitButton>
        <Button type="button" variant="outline" disabled={sub.pending} onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
