"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { JobLotConsumptionRow } from "@/lib/api-types";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

export interface ReturnMaterialOption {
  materialItemId: string;
  label: string;
  uom: string;
  /** Currently out (issued net of prior returns) -- the most this material can have returned. */
  outstandingQty: string;
}

interface LotReturnRow {
  key: string;
  lotId: string;
  quantity: string;
  disposition: "good" | "quarantine";
}

// Returns unused or rejected material from a job -- the inverse of
// IssueMaterialForm. If this job's consumption of the chosen material was
// lot-tracked (lotsForMaterial non-empty), the caller must say which lot(s)
// the returned quantity traces back to, each bounded by what the job
// actually drew from that lot and hasn't already returned -- see
// material-issue-service.ts's returnMaterialFromJob for the full validation
// this mirrors client-side. "Quarantine" disposition means the returned
// quantity needs inspection before it can be reissued: it is held back from
// the original lot and spawns a new, separately tracked quarantined lot
// rather than silently going straight back into good stock.
export function ReturnMaterialForm({
  jobId,
  material,
  warehouses,
  lotsForMaterial,
  onReturned,
}: {
  jobId: string;
  material: ReturnMaterialOption;
  /** Warehouses this return can be posted into. For a lot-tracked material this is deliberately restricted to warehouses holding an outstanding lot of it (lotsForMaterial's distinct warehouseIds); for an untracked one it's every active warehouse in the job's branch. */
  warehouses: { id: string; name: string }[];
  /** Empty = this material's consumption on this job was never lot-tracked. */
  lotsForMaterial: JobLotConsumptionRow[];
  onReturned?: () => void;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const isLotTracked = lotsForMaterial.length > 0;
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0]!.id : "");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [lotRows, setLotRows] = useState<LotReturnRow[]>([]);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean } | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  const lotsInWarehouse = lotsForMaterial.filter((l) => l.warehouseId === warehouseId && Number(l.netOutstanding) > 0);

  function addLotRow() {
    setLotRows((rows) => [...rows, { key: crypto.randomUUID(), lotId: "", quantity: "", disposition: "good" }]);
  }
  function setLotRow(key: string, patch: Partial<LotReturnRow>) {
    setLotRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeLotRow(key: string) {
    setLotRows((rows) => rows.filter((r) => r.key !== key));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!warehouseId) problems.warehouseId = "Choose which warehouse the material is going back into.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    if (q.ok && Number(material.outstandingQty) > 0 && q.value > Number(material.outstandingQty) + 1e-9) {
      problems.quantity = `Can't return more than is currently issued and not yet returned (${formatQuantity(material.outstandingQty, material.uom)}).`;
    }
    if (reason.trim().length < 3) problems.reason = "Say briefly why this is being returned.";

    let lotReturns: { lotId: string; quantity: number; disposition: "good" | "quarantine" }[] | undefined;
    if (isLotTracked) {
      if (lotRows.length === 0) problems.lotReturns = "Add at least one lot this quantity is coming back from.";
      const seen = new Set<string>();
      let sum = 0;
      for (const row of lotRows) {
        if (!row.lotId) { problems.lotReturns = "Choose a lot for every row."; continue; }
        if (seen.has(row.lotId)) { problems.lotReturns = "Each lot can only be used once."; continue; }
        seen.add(row.lotId);
        const rq = parseDecimalInput(row.quantity, { maxDecimals: 4, min: "positive", label: "Lot quantity" });
        if (!rq.ok) { problems.lotReturns = rq.message; continue; }
        const lot = lotsInWarehouse.find((l) => l.lotId === row.lotId);
        if (lot && rq.value > Number(lot.netOutstanding) + 1e-9) {
          problems.lotReturns = `Lot ${lot.lotNumber}: can't return more than this job has outstanding from it (${formatQuantity(lot.netOutstanding, material.uom)}).`;
          continue;
        }
        sum += rq.value;
      }
      if (!problems.lotReturns && q.ok && Math.abs(sum - q.value) > 1e-6) {
        problems.lotReturns = `Lot quantities (${sum}) must add up to the return quantity (${q.value}).`;
      }
      if (!problems.lotReturns) {
        lotReturns = lotRows.map((r) => ({ lotId: r.lotId, quantity: Number(r.quantity), disposition: r.disposition }));
      }
    }

    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { materialItemId: material.materialItemId, warehouseId, quantity: q.value, reason: reason.trim(), ...(lotReturns ? { lotReturns } : {}) };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(
      () => apiRequest(`/api/v1/production-jobs/${jobId}/material-returns`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }),
      { idempotency: idem.current, visibleFields: ["materialItemId", "warehouseId", "quantity", "reason", "lotReturns"] },
    );
    if (result?.ok) {
      setDone({ text: `Returned ${formatQuantity(String(q.value), material.uom)} of ${material.label}.`, replayed: result.replayed });
      setQty("");
      setReason("");
      setLotRows([]);
      onReturned?.();
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormError message={sub.error} />
      {done ? (
        <Notice tone="success">
          {done.replayed ? "This return had already been recorded, so nothing new was posted. " : ""}
          {done.text}
        </Notice>
      ) : null}
      {isLotTracked ? (
        <Notice tone="neutral">This material was issued from specific lots. Say which lot(s) the returned quantity traces back to below.</Notice>
      ) : null}
      <Field id="ret-wh" label="Returning into warehouse" required error={errors.warehouseId}>
        <Select id="ret-wh" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLotRows([]); }} aria-invalid={Boolean(errors.warehouseId) || undefined}>
          <option value="">Choose warehouse…</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        id="ret-qty"
        label={`Quantity (${material.uom})`}
        required
        error={errors.quantity}
        hint={`Currently issued and not yet returned: ${formatQuantity(material.outstandingQty, material.uom)}.`}
      >
        <Input id="ret-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("ret-qty", { error: errors.quantity, hint: "x" })} />
      </Field>
      <Field id="ret-reason" label="Reason" required error={errors.reason} hint='E.g. "job over-issued", "found damaged after issue", "wrong material pulled".'>
        <Textarea id="ret-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(errors.reason) || undefined} />
      </Field>

      {warehouseId ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm font-medium">{isLotTracked ? "Lot breakdown" : "This material was not lot-tracked on this job."}</p>
          {isLotTracked ? (
            <div className="space-y-2">
              {errors.lotReturns ? <Notice tone="danger">{errors.lotReturns}</Notice> : null}
              {lotsInWarehouse.length === 0 ? (
                <Notice tone="warning">No lot in this warehouse still has an outstanding balance for this job. Choose a different warehouse.</Notice>
              ) : null}
              {lotRows.map((row) => {
                const chosenElsewhere = new Set(lotRows.filter((r) => r.key !== row.key).map((r) => r.lotId));
                return (
                  <div key={row.key} className="flex flex-wrap items-end gap-2">
                    <Field id={`rlot-${row.key}`} label="Lot" className="min-w-48 flex-1">
                      <Select id={`rlot-${row.key}`} value={row.lotId} onChange={(e) => setLotRow(row.key, { lotId: e.target.value })}>
                        <option value="">Choose lot…</option>
                        {lotsInWarehouse
                          .filter((l) => !chosenElsewhere.has(l.lotId))
                          .map((l) => (
                            <option key={l.lotId} value={l.lotId}>
                              {l.lotNumber} — {formatQuantity(l.netOutstanding, material.uom)} outstanding
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <Field id={`rlotqty-${row.key}`} label={`Quantity (${material.uom})`} className="w-36">
                      <Input id={`rlotqty-${row.key}`} inputMode="decimal" value={row.quantity} onChange={(e) => setLotRow(row.key, { quantity: e.target.value })} />
                    </Field>
                    <Field id={`rlotdisp-${row.key}`} label="Condition" className="w-40">
                      <Select id={`rlotdisp-${row.key}`} value={row.disposition} onChange={(e) => setLotRow(row.key, { disposition: e.target.value as "good" | "quarantine" })}>
                        <option value="good">Good — back to stock</option>
                        <option value="quarantine">Needs inspection</option>
                      </Select>
                    </Field>
                    <Button type="button" variant="outline" onClick={() => removeLotRow(row.key)}>
                      Remove
                    </Button>
                  </div>
                );
              })}
              <Button type="button" variant="outline" onClick={addLotRow} disabled={lotsInWarehouse.length === 0}>
                Add lot
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <SubmitButton pending={sub.pending} pendingLabel="Returning…">
        Return material
      </SubmitButton>
    </form>
  );
}
