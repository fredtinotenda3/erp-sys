"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { StockBalance } from "@/lib/api-types";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

export interface IssueMaterialOption {
  materialItemId: string;
  label: string;
  uom: string;
  remainingQty: string;
  expectedQty: string;
  issuedQty: string;
}

export interface WarehouseOption {
  id: string;
  name: string;
}

// Issues one material to one job. Posts to the existing material-issues
// endpoint with a clientRequestId that is created once per logical submission
// and reused on retry (lib/idempotency.ts), so a double-click or a retry after
// a dropped connection can't issue the material twice. The cost of the issue
// is decided by the server (weighted-average) and is never computed here.
export function IssueMaterialForm({
  jobId,
  materials,
  warehouses,
  onIssued,
}: {
  jobId: string;
  materials: IssueMaterialOption[];
  warehouses: WarehouseOption[];
  onIssued?: () => void;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [materialId, setMaterialId] = useState(materials.length === 1 ? materials[0]!.materialItemId : "");
  const [warehouseId, setWarehouseId] = useState(warehouses.length === 1 ? warehouses[0]!.id : "");
  const [qty, setQty] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ text: string; replayed: boolean } | null>(null);
  const [onHand, setOnHand] = useState<{ state: "idle" | "loading" | "ok" | "error"; value?: string }>({ state: "idle" });
  const errors = { ...sub.fieldErrors, ...local };
  const material = materials.find((m) => m.materialItemId === materialId);

  // Show what is actually on hand for this material in this warehouse, read from the balances endpoint.
  useEffect(() => {
    if (!materialId || !warehouseId) return;
    const controller = new AbortController();
    void apiRequest<StockBalance[]>(`/api/v1/stock/balances?itemId=${materialId}&warehouseId=${warehouseId}`, { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return;
      setOnHand(r.ok ? { state: "ok", value: r.data[0]?.quantity ?? "0" } : { state: "error" });
    });
    return () => controller.abort();
  }, [materialId, warehouseId, done]);

  const hasPair = Boolean(materialId && warehouseId);
  const stockLine = !hasPair
    ? null
    : onHand.state === "ok"
      ? `On hand in this warehouse: ${formatQuantity(onHand.value, material?.uom)}`
      : onHand.state === "error"
        ? "On-hand quantity couldn't be loaded."
        : "Checking on-hand quantity…";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(null);
    const problems: Record<string, string> = {};
    if (!materialId) problems.materialItemId = "Choose a material.";
    if (!warehouseId) problems.warehouseId = "Choose the warehouse it comes from.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Quantity" });
    if (!q.ok) problems.quantity = q.message;
    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { materialItemId: materialId, warehouseId, quantity: q.value };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(
      () => apiRequest(`/api/v1/production-jobs/${jobId}/material-issues`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }),
      { idempotency: idem.current, visibleFields: ["materialItemId", "warehouseId", "quantity"] },
    );
    if (result?.ok) {
      setDone({ text: `Issued ${formatQuantity(String(q.value), material?.uom)} of ${material?.label ?? "material"}.`, replayed: result.replayed });
      setQty("");
      onIssued?.();
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <FormError message={sub.error} />
      {done ? (
        <Notice tone="success">
          {done.replayed ? "This issue had already been recorded, so nothing new was posted. " : ""}
          {done.text}
        </Notice>
      ) : null}
      <Field id="iss-material" label="Material" required error={errors.materialItemId}>
        <Select id="iss-material" value={materialId} onChange={(e) => { setMaterialId(e.target.value); setOnHand({ state: "idle" }); }} aria-invalid={Boolean(errors.materialItemId) || undefined} aria-describedby={describedBy("iss-material", { error: errors.materialItemId })}>
          <option value="">Choose material…</option>
          {materials.map((m) => (
            <option key={m.materialItemId} value={m.materialItemId}>
              {m.label} — {formatQuantity(m.remainingQty, m.uom)} still needed
            </option>
          ))}
        </Select>
      </Field>
      <Field id="iss-wh" label="From warehouse" required error={errors.warehouseId} hint={stockLine ?? undefined}>
        <Select id="iss-wh" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setOnHand({ state: "idle" }); }} aria-invalid={Boolean(errors.warehouseId) || undefined} aria-describedby={describedBy("iss-wh", { error: errors.warehouseId, hint: stockLine ?? undefined })}>
          <option value="">Choose warehouse…</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        id="iss-qty"
        label={`Quantity${material ? ` (${material.uom})` : ""}`}
        required
        error={errors.quantity}
        hint={material ? `Planned ${formatQuantity(material.expectedQty, material.uom)} · already issued ${formatQuantity(material.issuedQty, material.uom)}. Issuing more than planned is allowed and shows as a variance.` : undefined}
      >
        <Input id="iss-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.quantity) || undefined} aria-describedby={describedBy("iss-qty", { error: errors.quantity, hint: material ? "x" : undefined })} />
      </Field>
      <SubmitButton pending={sub.pending} pendingLabel="Issuing…">
        Issue material
      </SubmitButton>
    </form>
  );
}
