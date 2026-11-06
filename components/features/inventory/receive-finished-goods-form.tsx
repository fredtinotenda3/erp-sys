"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

export interface FgWarehouseOption {
  id: string;
  name: string;
}

// Converts recorded good shop-floor output into a valued FinishedGoodsBatch
// (finished-goods-service.ts's receiveFinishedGoods). The server, not this
// form, is the authority on how much can be received -- uncommittedGoodQty
// is only a hint taken at page-render time; a concurrent receive by someone
// else is still caught by the per-job advisory lock and reported back as a
// normal field-less validation error.
export function ReceiveFinishedGoodsForm({
  jobId,
  uom,
  uncommittedGoodQty,
  warehouses,
  onReceived,
}: {
  jobId: string;
  uom: string;
  uncommittedGoodQty: string;
  warehouses: FgWarehouseOption[];
  onReceived?: () => void;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0]!.id : "");
  const [qty, setQty] = useState("");
  const [disposition, setDisposition] = useState<"available" | "quarantine">("available");
  const [qualityNotes, setQualityNotes] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!warehouseId) problems.warehouseId = "Choose a warehouse.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = {
      warehouseId,
      quantity: q.value,
      disposition,
      ...(qualityNotes.trim() ? { qualityNotes: qualityNotes.trim() } : {}),
    };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(
      () => apiRequest(`/api/v1/production-jobs/${jobId}/finished-goods`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }),
      { idempotency: idem.current, visibleFields: ["warehouseId", "quantity", "disposition", "qualityNotes"] },
    );
    if (result?.ok) {
      setDone({ text: `Received ${formatQuantity(String(q.value), uom)} into finished goods.`, replayed: result.replayed });
      setQty("");
      setQualityNotes("");
      onReceived?.();
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormError message={sub.error} />
      {done ? (
        <Notice tone="success">
          {done.replayed ? "This receipt had already been recorded, so nothing new was posted. " : ""}
          {done.text}
        </Notice>
      ) : null}
      <Field id="fg-wh" label="Receive into warehouse" required error={errors.warehouseId}>
        <Select id="fg-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-invalid={Boolean(errors.warehouseId) || undefined} aria-describedby={describedBy("fg-wh", { error: errors.warehouseId })}>
          <option value="">Choose warehouse…</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        id="fg-qty"
        label={`Quantity (${uom})`}
        required
        error={errors.quantity}
        hint={`Not yet received into finished goods: ${formatQuantity(uncommittedGoodQty, uom)}. The server re-checks this at the moment of posting.`}
      >
        <Input id="fg-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("fg-qty", { error: errors.quantity, hint: "x" })} />
      </Field>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Disposition</legend>
        <div className="flex gap-4 text-sm">
          {(["available", "quarantine"] as const).map((d) => (
            <label key={d} className="flex items-center gap-2">
              <input type="radio" name="disposition" checked={disposition === d} onChange={() => setDisposition(d)} className="accent-[var(--primary)]" />
              {d === "available" ? "Available immediately" : "Hold in quarantine"}
            </label>
          ))}
        </div>
      </fieldset>
      <Field id="fg-notes" label="Quality notes" error={errors.qualityNotes} hint="Optional.">
        <Textarea id="fg-notes" value={qualityNotes} maxLength={1000} onChange={(e) => setQualityNotes(e.target.value)} aria-invalid={Boolean(errors.qualityNotes) || undefined} />
      </Field>
      <SubmitButton pending={sub.pending} pendingLabel="Receiving…">
        Receive to finished goods
      </SubmitButton>
    </form>
  );
}
