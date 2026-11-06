"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

export interface TransferWarehouseOption {
  id: string;
  name: string;
}

/**
 * Moves part or all of a batch's remaining quantity to another warehouse
 * (finished-goods-service.ts's transferBatch). Spawns a new, linked batch at
 * the destination -- this batch's own id and quantity never change, only its
 * remaining balance -- so the dialog closes to a page refresh rather than
 * trying to show "the new batch" inline.
 */
export function FgBatchTransferActions({
  batchId,
  batchNumber,
  remaining,
  uom,
  currentWarehouseId,
  warehouses,
}: {
  batchId: string;
  batchNumber: string;
  remaining: string;
  uom: string;
  currentWarehouseId: string;
  warehouses: TransferWarehouseOption[];
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [open, setOpen] = useState(false);
  const [destinationWarehouseId, setDestinationWarehouseId] = useState("");
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const errors = { ...sub.fieldErrors, ...local };
  const destinations = warehouses.filter((w) => w.id !== currentWarehouseId);

  function close() {
    if (sub.pending) return;
    setOpen(false);
    sub.clear();
    setLocal({});
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!destinationWarehouseId) problems.destinationWarehouseId = "Choose a destination warehouse.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    else if (q.value > Number(remaining)) problems.quantity = `Only ${formatQuantity(remaining, uom)} remains in this batch.`;
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { destinationWarehouseId, quantity: q.value, ...(notes.trim() ? { notes: notes.trim() } : {}) };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(
      () => apiRequest(`/api/v1/inventory/finished-goods/${batchId}/transfer`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }),
      { idempotency: idem.current, visibleFields: ["destinationWarehouseId", "quantity", "notes"] },
    );
    if (result?.ok) {
      setDone(`Transferred ${formatQuantity(String(q.value), uom)} out of ${batchNumber}.${result.replayed ? " (This transfer had already been recorded.)" : ""}`);
      setQty("");
      setNotes("");
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={destinations.length === 0}>
        <ArrowRightLeft /> Transfer
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        title={`Transfer from batch ${batchNumber}`}
        description="Moves part or all of this batch's remaining quantity to another warehouse. The source batch is unchanged except for its remaining balance; a new linked batch is created at the destination."
      >
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <FormError message={sub.error} />
          {done ? <Notice tone="success">{done}</Notice> : null}
          <Field id="fg-xfer-dest" label="Destination warehouse" required error={errors.destinationWarehouseId}>
            <Select
              id="fg-xfer-dest"
              value={destinationWarehouseId}
              onChange={(e) => setDestinationWarehouseId(e.target.value)}
              aria-invalid={Boolean(errors.destinationWarehouseId) || undefined}
              aria-describedby={describedBy("fg-xfer-dest", { error: errors.destinationWarehouseId })}
            >
              <option value="">Choose warehouse…</option>
              {destinations.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="fg-xfer-qty" label={`Quantity (${uom})`} required error={errors.quantity} hint={`Remaining in this batch: ${formatQuantity(remaining, uom)}`}>
            <Input id="fg-xfer-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("fg-xfer-qty", { error: errors.quantity, hint: "x" })} />
          </Field>
          <Field id="fg-xfer-notes" label="Notes" error={errors.notes} hint="Optional.">
            <Textarea id="fg-xfer-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <SubmitButton pending={sub.pending} pendingLabel="Transferring…">
            Transfer
          </SubmitButton>
        </form>
      </Modal>
    </>
  );
}
