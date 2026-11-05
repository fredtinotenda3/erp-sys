"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import { REJECT_REASON_OPTIONS } from "@/lib/labels";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

export interface ReceivableLine {
  id: string; // PO line id
  itemId: string;
  sku: string;
  itemName: string;
  uom: string;
  outstandingQty: string;
}

interface LineState {
  included: boolean;
  warehouseId: string;
  receivedQty: string;
  rejectedQty: string;
  rejectReason: string;
  supplierLotRef: string;
  expiryDate: string;
  notes: string;
}

// Records one delivery against a confirmed/partially-received purchase
// order: which lines arrived, how much, how much of that was rejected at
// inspection (and why), into which warehouse, with the supplier's own lot
// reference and expiry if they gave one. Accepted quantity is never typed
// directly -- it is always received minus rejected, computed here, so the
// client can't submit numbers that don't add up (the server enforces the
// same invariant -- see goods-receipt-service.ts).
export function GoodsReceiptForm({
  poId,
  poNumber,
  lines,
  warehouses,
}: {
  poId: string;
  poNumber: string;
  lines: ReceivableLine[];
  warehouses: { id: string; name: string }[];
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const defaultWarehouseId = warehouses.length === 1 ? warehouses[0]!.id : "";
  const [deliveryReference, setDeliveryReference] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [headerNotes, setHeaderNotes] = useState("");
  const [rows, setRows] = useState<Record<string, LineState>>(
    Object.fromEntries(
      lines.map((l) => [l.id, { included: false, warehouseId: defaultWarehouseId, receivedQty: "", rejectedQty: "", rejectReason: "", supplierLotRef: "", expiryDate: "", notes: "" }]),
    ),
  );
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  const setRow = (id: string, patch: Partial<LineState>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    const payloadLines: {
      poLineId: string;
      warehouseId: string;
      receivedQty: number;
      acceptedQty: number;
      rejectedQty: number;
      rejectReason?: string;
      supplierLotRef?: string;
      expiryDate?: string;
      notes?: string;
    }[] = [];

    for (const line of lines) {
      const row = rows[line.id]!;
      if (!row.included) continue;
      const received = parseDecimalInput(row.receivedQty, { maxDecimals: 4, min: "positive", label: "Received quantity" });
      if (!received.ok) problems[`${line.id}.received`] = received.message;
      const rejected = row.rejectedQty.trim() === "" ? ({ ok: true, value: 0 } as const) : parseDecimalInput(row.rejectedQty, { maxDecimals: 4, min: "nonnegative", label: "Rejected quantity" });
      if (!rejected.ok) problems[`${line.id}.rejected`] = rejected.message;
      if (received.ok && rejected.ok && rejected.value > received.value) problems[`${line.id}.rejected`] = "Can't exceed the quantity received.";
      if (rejected.ok && rejected.value > 0 && !row.rejectReason) problems[`${line.id}.rejectReason`] = "Choose why it was rejected.";
      if (!row.warehouseId) problems[`${line.id}.warehouseId`] = "Choose a warehouse.";
      if (row.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(row.expiryDate)) problems[`${line.id}.expiryDate`] = "Use a valid date.";

      if (received.ok && rejected.ok && row.warehouseId && !(rejected.ok && rejected.value > 0 && !row.rejectReason)) {
        payloadLines.push({
          poLineId: line.id,
          warehouseId: row.warehouseId,
          receivedQty: received.value,
          acceptedQty: received.value - rejected.value,
          rejectedQty: rejected.value,
          ...(rejected.value > 0 ? { rejectReason: row.rejectReason } : {}),
          ...(row.supplierLotRef.trim() ? { supplierLotRef: row.supplierLotRef.trim() } : {}),
          ...(row.expiryDate ? { expiryDate: row.expiryDate } : {}),
          ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
        });
      }
    }
    if (payloadLines.length === 0 && Object.keys(problems).length === 0) problems.form = "Enter what arrived on at least one line.";
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail(problems.form ?? "Fix the highlighted fields and try again.");

    const payload = {
      deliveryReference: deliveryReference.trim() || undefined,
      // Treated as UTC midnight of the chosen calendar date, same convention
      // every other date-only picker in this app uses (see e.g.
      // purchase-order-form.tsx's requestedDeliveryDate), so the date shown
      // never shifts by the viewer's timezone.
      receivedAt: receivedAt ? `${receivedAt}T00:00:00Z` : undefined,
      notes: headerNotes.trim() || undefined,
      lines: payloadLines,
    };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(
      () => apiRequest<{ id: string }>(`/api/v1/purchase-orders/${poId}/goods-receipts`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }),
      { idempotency: idem.current },
    );
    if (result?.ok) {
      setDone({ text: `Receipt recorded against ${poNumber} (${payloadLines.length} line${payloadLines.length === 1 ? "" : "s"}).`, replayed: result.replayed });
      router.push(`/purchasing/orders/${poId}`);
      router.refresh();
    }
  }

  const anySelected = lines.some((l) => rows[l.id]!.included);

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-5xl space-y-5">
      <FormError message={sub.error} />
      {done ? <Notice tone="success">{done.replayed ? "This delivery had already been recorded, so nothing new was posted. " : ""}{done.text}</Notice> : null}

      <Card className="grid gap-4 p-4 sm:grid-cols-3">
        <Field id="gr-ref" label="Delivery reference" hint="The supplier's delivery note number, if any.">
          <Input id="gr-ref" value={deliveryReference} maxLength={100} onChange={(e) => setDeliveryReference(e.target.value)} />
        </Field>
        <Field id="gr-date" label="Received on" hint="Leave blank to use right now.">
          <Input id="gr-date" type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
        <Field id="gr-notes" label="Notes">
          <Input id="gr-notes" value={headerNotes} maxLength={2000} onChange={(e) => setHeaderNotes(e.target.value)} />
        </Field>
      </Card>

      {local.form ? <Notice tone="danger">{local.form}</Notice> : null}

      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold">What arrived</legend>
        {lines.map((line) => {
          const row = rows[line.id]!;
          const le = (suffix: string) => errors[`${line.id}.${suffix}`];
          return (
            <Card key={line.id} className={`space-y-3 p-3 ${row.included ? "" : "opacity-70"}`}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={row.included} onChange={(e) => setRow(line.id, { included: e.target.checked })} className="size-4 rounded border-border" />
                {line.itemName} <span className="text-xs font-normal text-muted-foreground">({line.sku}) — outstanding {formatQuantity(line.outstandingQty, line.uom)}</span>
              </label>
              {row.included ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field id={`wh-${line.id}`} label="Warehouse" required error={le("warehouseId")}>
                    <Select id={`wh-${line.id}`} value={row.warehouseId} onChange={(e) => setRow(line.id, { warehouseId: e.target.value })} aria-invalid={le("warehouseId") ? true : undefined}>
                      <option value="">Choose warehouse…</option>
                      {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </Select>
                  </Field>
                  <Field id={`rq-${line.id}`} label={`Received (${line.uom})`} required error={le("received")}>
                    <Input id={`rq-${line.id}`} inputMode="decimal" value={row.receivedQty} onChange={(e) => setRow(line.id, { receivedQty: e.target.value })} aria-invalid={le("received") ? true : undefined} />
                  </Field>
                  <Field id={`jq-${line.id}`} label={`Rejected (${line.uom})`} error={le("rejected")} hint="Leave blank if everything was accepted.">
                    <Input id={`jq-${line.id}`} inputMode="decimal" value={row.rejectedQty} onChange={(e) => setRow(line.id, { rejectedQty: e.target.value })} aria-invalid={le("rejected") ? true : undefined} />
                  </Field>
                  <Field id={`rr-${line.id}`} label="Reject reason" error={le("rejectReason")} hint="Required when something is rejected.">
                    <Select id={`rr-${line.id}`} value={row.rejectReason} onChange={(e) => setRow(line.id, { rejectReason: e.target.value })} aria-invalid={le("rejectReason") ? true : undefined}>
                      <option value="">None</option>
                      {REJECT_REASON_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </Select>
                  </Field>
                  <Field id={`lot-${line.id}`} label="Supplier lot/batch ref" hint="Optional.">
                    <Input id={`lot-${line.id}`} value={row.supplierLotRef} maxLength={100} onChange={(e) => setRow(line.id, { supplierLotRef: e.target.value })} />
                  </Field>
                  <Field id={`exp-${line.id}`} label="Expiry date" error={le("expiryDate")} hint="Optional.">
                    <Input id={`exp-${line.id}`} type="date" value={row.expiryDate} onChange={(e) => setRow(line.id, { expiryDate: e.target.value })} aria-describedby={describedBy(`exp-${line.id}`, { error: le("expiryDate") })} />
                  </Field>
                  <Field id={`note-${line.id}`} label="Line notes" className="sm:col-span-3" hint="Optional.">
                    <Textarea id={`note-${line.id}`} rows={1} value={row.notes} maxLength={500} onChange={(e) => setRow(line.id, { notes: e.target.value })} />
                  </Field>
                </div>
              ) : null}
            </Card>
          );
        })}
      </fieldset>

      <div className="flex gap-2">
        <SubmitButton pending={sub.pending} pendingLabel="Recording…" disabled={!anySelected}>Record receipt</SubmitButton>
        <Button type="button" variant="outline" disabled={sub.pending} onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
