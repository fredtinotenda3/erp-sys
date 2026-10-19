"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CurrencySelect, FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { useOnHand } from "./use-on-hand";
import type { ItemOption } from "./receive-form";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { Currency } from "@/lib/api-types";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput, requireText } from "@/lib/validate";

type Prepared = { payload: Record<string, unknown>; summary: string };

// Adjustments write a permanent ledger row. A reason is mandatory, a decrease is
// valued at the current average cost by the server (no cost is accepted), an
// increase needs its own unit cost + currency, and the user must confirm a
// summary before anything is sent.
export function AdjustForm({ items, warehouses, currencies, canSeeCost }: { items: ItemOption[]; warehouses: { id: string; name: string }[]; currencies: Currency[]; canSeeCost: boolean }) {
  void canSeeCost;
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [itemId, setItemId] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0]!.id : "");
  const [direction, setDirection] = useState<"increase" | "decrease">("decrease");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("");
  const [reason, setReason] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [pendingConfirm, setPendingConfirm] = useState<Prepared | null>(null);
  const [done, setDone] = useState<{ text: string; replayed: boolean; at: number } | null>(null);
  const onHand = useOnHand(itemId, warehouseId, done?.at ?? null);
  const item = items.find((i) => i.id === itemId);
  const whName = warehouses.find((w) => w.id === warehouseId)?.name;
  const errors = { ...sub.fieldErrors, ...local };

  function review(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!itemId) problems.itemId = "Choose an item.";
    if (!warehouseId) problems.warehouseId = "Choose a warehouse.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    const reasonErr = requireText(reason, "Reason", { min: 3, max: 500 });
    if (reasonErr) problems.reason = reasonErr;
    const payload: Record<string, unknown> = { warehouseId, itemId, reason: reason.trim() };
    if (q.ok) payload.quantity = direction === "increase" ? q.value : -q.value;
    if (direction === "increase") {
      const c = parseDecimalInput(cost, { maxDecimals: 4, min: "nonnegative", label: "Unit cost" });
      if (!c.ok) problems.unitCost = c.message;
      else if (!currency) problems.currency = "Choose the currency of the unit cost.";
      else {
        payload.unitCost = c.value;
        payload.currency = currency;
      }
    }
    if (direction === "decrease" && q.ok && onHand.state === "ok" && q.value > Number(onHand.quantity)) {
      problems.quantity = `Only ${formatQuantity(onHand.quantity, item?.uom)} is on hand; stock can't go negative.`;
    }
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");
    sub.clear();
    const verb = direction === "increase" ? "Increase" : "Decrease";
    setPendingConfirm({ payload, summary: `${verb} ${item?.label ?? "item"} by ${formatQuantity(String(q.value), item?.uom)} in ${whName ?? "the warehouse"}.` });
  }

  async function submit() {
    if (!pendingConfirm) return;
    const prepared = idem.current.prepare(pendingConfirm.payload);
    if (!prepared.ok) {
      setPendingConfirm(null);
      return sub.fail(prepared.reason);
    }
    const result = await sub.run(() => apiRequest("/api/v1/stock/adjustments", { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...pendingConfirm.payload } }), {
      idempotency: idem.current,
      visibleFields: ["itemId", "warehouseId", "quantity", "unitCost", "currency", "reason"],
    });
    if (!result) return;
    setPendingConfirm(null);
    if (result.ok) {
      setDone({ text: `${pendingConfirm.summary} Recorded.`, replayed: result.replayed, at: (done?.at ?? 0) + 1 });
      setQty("");
      setReason("");
      router.refresh();
    }
  }

  const stockHint = onHand.state === "ok" ? `On hand now: ${formatQuantity(onHand.quantity, item?.uom)}` : onHand.state === "error" ? "On-hand quantity couldn't be loaded." : undefined;

  return (
    <>
      <form onSubmit={review} noValidate className="max-w-xl space-y-4">
        <FormError message={sub.error} />
        {done ? (
          <Notice tone="success">
            {done.replayed ? "This adjustment had already been recorded, so nothing new was posted. " : ""}
            {done.text}
          </Notice>
        ) : null}
        <Field id="ad-item" label="Item" required error={errors.itemId}>
          <Select id="ad-item" value={itemId} onChange={(e) => setItemId(e.target.value)} aria-invalid={Boolean(errors.itemId) || undefined} aria-describedby={describedBy("ad-item", { error: errors.itemId })}>
            <option value="">Choose item…</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="ad-wh" label="Warehouse" required error={errors.warehouseId} hint={stockHint}>
          <Select id="ad-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-invalid={Boolean(errors.warehouseId) || undefined} aria-describedby={describedBy("ad-wh", { error: errors.warehouseId, hint: stockHint })}>
            <option value="">Choose warehouse…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Direction</legend>
          <div className="flex gap-4 text-sm">
            {(["decrease", "increase"] as const).map((d) => (
              <label key={d} className="flex items-center gap-2">
                <input type="radio" name="direction" checked={direction === d} onChange={() => setDirection(d)} className="accent-[var(--primary)]" />
                {d === "decrease" ? "Decrease (write off / shrinkage)" : "Increase (found stock)"}
              </label>
            ))}
          </div>
        </fieldset>
        <Field id="ad-qty" label={`Quantity to ${direction}${item ? ` (${item.uom})` : ""}`} required error={errors.quantity}>
          <Input id="ad-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("ad-qty", { error: errors.quantity })} />
        </Field>
        {direction === "increase" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="ad-cost" label="Unit cost" required error={errors.unitCost}>
              <Input id="ad-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-invalid={Boolean(errors.unitCost) || undefined} aria-describedby={describedBy("ad-cost", { error: errors.unitCost })} />
            </Field>
            <Field id="ad-cur" label="Currency" required error={errors.currency}>
              <CurrencySelect id="ad-cur" value={currency} onChange={setCurrency} currencies={currencies} invalid={Boolean(errors.currency)} describedBy={describedBy("ad-cur", { error: errors.currency })} />
            </Field>
          </div>
        ) : (
          <Notice tone="neutral">A decrease is valued at the current average cost automatically.</Notice>
        )}
        <Field id="ad-reason" label="Reason" required error={errors.reason} hint="Recorded permanently with your name. At least 3 characters.">
          <Textarea id="ad-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason) || undefined} aria-describedby={describedBy("ad-reason", { error: errors.reason, hint: "x" })} />
        </Field>
        <Button type="submit" disabled={sub.pending}>
          Review adjustment
        </Button>
      </form>

      <Modal
        open={pendingConfirm !== null}
        onClose={() => !sub.pending && setPendingConfirm(null)}
        dismissible={!sub.pending}
        size="sm"
        title="Confirm stock adjustment"
        description="This writes a permanent ledger entry. It can be offset by another adjustment, but never edited or deleted."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setPendingConfirm(null)} disabled={sub.pending}>
              Back
            </Button>
            <Button type="button" onClick={submit} disabled={sub.pending} aria-busy={sub.pending} variant={direction === "decrease" ? "destructive" : "primary"}>
              {sub.pending ? "Recording…" : "Record adjustment"}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <FormError message={sub.error} />
          <p className="font-medium">{pendingConfirm?.summary}</p>
          <p className="text-muted-foreground">Reason: {String(pendingConfirm?.payload.reason ?? "")}</p>
        </div>
      </Modal>
    </>
  );
}
