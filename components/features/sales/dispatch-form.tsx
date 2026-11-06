"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Field } from "../../ui/field";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { Notice } from "../../ui/notice";
import { FormError, SubmitButton } from "../shared/form-bits";
import { useSubmission } from "../shared/use-submission";
import { apiRequest } from "../../../lib/api-client";
import { IdempotentRequest } from "../../../lib/idempotency";
import { formatQuantity } from "../../../lib/format";
import { parseDecimalInput } from "../../../lib/validate";

export interface DispatchableLine {
  id: string; // sales order line id
  itemId: string;
  sku: string;
  itemName: string;
  uom: string;
  remainingToDispatchQty: string;
}

interface LineState {
  included: boolean;
  quantity: string;
}

// Ships part or all of a confirmed order's outstanding lines from one
// warehouse. Which finished-goods batch(es) each line is picked from is
// decided server-side (oldest batch first; see dispatch-service.ts) -- this
// form deliberately doesn't expose a batch picker, the same "default
// auto-allocate, no picker in the basic UI" choice issue-material-dialog.tsx
// already makes for raw-material lots. The resulting batch breakdown is
// still shown afterwards on the dispatch's own detail page.
export function DispatchForm({
  orderId,
  orderNumber,
  lines,
  warehouses,
}: {
  orderId: string;
  orderNumber: string;
  lines: DispatchableLine[];
  warehouses: { id: string; name: string }[];
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const defaultWarehouseId = warehouses.length === 1 ? warehouses[0]!.id : "";
  const [warehouseId, setWarehouseId] = useState(defaultWarehouseId);
  const [carrier, setCarrier] = useState("");
  const [trackingReference, setTrackingReference] = useState("");
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<Record<string, LineState>>(
    Object.fromEntries(lines.map((l) => [l.id, { included: false, quantity: "" }])),
  );
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  const setRow = (id: string, patch: Partial<LineState>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!warehouseId) problems.warehouseId = "Choose a warehouse.";

    const payloadLines: { salesOrderLineId: string; quantity: number }[] = [];
    for (const line of lines) {
      const row = rows[line.id]!;
      if (!row.included) continue;
      const parsed = parseDecimalInput(row.quantity, { maxDecimals: 4, min: "positive", label: "Quantity" });
      if (!parsed.ok) {
        problems[`${line.id}.quantity`] = parsed.message;
        continue;
      }
      if (parsed.value > Number(line.remainingToDispatchQty)) {
        problems[`${line.id}.quantity`] = `Can't exceed what's outstanding (${formatQuantity(line.remainingToDispatchQty, line.uom)}).`;
        continue;
      }
      payloadLines.push({ salesOrderLineId: line.id, quantity: parsed.value });
    }
    if (payloadLines.length === 0 && !problems.form) problems.form = "Enter a quantity for at least one line.";
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail(problems.form ?? "Fix the highlighted fields and try again.");

    const payload = {
      warehouseId,
      carrier: carrier.trim() || undefined,
      trackingReference: trackingReference.trim() || undefined,
      notes: notes.trim() || undefined,
      lines: payloadLines,
    };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(
      () => apiRequest<{ id: string }>(`/api/v1/sales-orders/${orderId}/dispatches`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }),
      { idempotency: idem.current },
    );
    if (result?.ok) {
      setDone({ text: `Dispatch recorded against ${orderNumber} (${payloadLines.length} line${payloadLines.length === 1 ? "" : "s"}).`, replayed: result.replayed });
      router.push(`/dispatches/${result.data.id}`);
      router.refresh();
    }
  }

  const anySelected = lines.some((l) => rows[l.id]!.included);

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-4xl space-y-5">
      <FormError message={sub.error} />
      {done ? <Notice tone="success">{done.replayed ? "This dispatch had already been recorded, so nothing new was posted. " : ""}{done.text}</Notice> : null}

      <Card className="grid gap-4 p-4 sm:grid-cols-2">
        <Field id="dp-wh" label="Warehouse" required error={errors.warehouseId}>
          <Select id="dp-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-invalid={errors.warehouseId ? true : undefined}>
            <option value="">Choose warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>
        <Field id="dp-carrier" label="Carrier" hint="Optional.">
          <Input id="dp-carrier" value={carrier} maxLength={100} onChange={(e) => setCarrier(e.target.value)} />
        </Field>
        <Field id="dp-track" label="Tracking reference" hint="Optional.">
          <Input id="dp-track" value={trackingReference} maxLength={100} onChange={(e) => setTrackingReference(e.target.value)} />
        </Field>
        <Field id="dp-notes" label="Notes" hint="Optional.">
          <Input id="dp-notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </Card>

      {local.form ? <Notice tone="danger">{local.form}</Notice> : null}

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold">What&apos;s shipping</legend>
        {lines.map((line) => {
          const row = rows[line.id]!;
          const err = errors[`${line.id}.quantity`];
          return (
            <Card key={line.id} className={`space-y-3 p-3 ${row.included ? "" : "opacity-70"}`}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={row.included} onChange={(e) => setRow(line.id, { included: e.target.checked })} className="size-4 rounded border-border" />
                {line.itemName} <span className="text-xs font-normal text-muted-foreground">({line.sku}) — outstanding {formatQuantity(line.remainingToDispatchQty, line.uom)}</span>
              </label>
              {row.included ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field id={`qty-${line.id}`} label={`Quantity (${line.uom})`} required error={err}>
                    <Input id={`qty-${line.id}`} inputMode="decimal" value={row.quantity} onChange={(e) => setRow(line.id, { quantity: e.target.value })} aria-invalid={err ? true : undefined} />
                  </Field>
                </div>
              ) : null}
            </Card>
          );
        })}
      </fieldset>

      <div className="flex gap-2">
        <SubmitButton pending={sub.pending} pendingLabel="Recording…" disabled={!anySelected}>Record dispatch</SubmitButton>
        <Button type="button" variant="outline" disabled={sub.pending} onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
