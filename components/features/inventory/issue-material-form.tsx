"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { MaterialLot, StockBalance } from "@/lib/api-types";
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

export type LotAllocationInput = { lotId: string; quantity: number };

interface LotAllocationRow {
  key: string;
  lotId: string;
  quantity: string;
}

let lotRowSeq = 0;
function newLotRowKey(): string {
  lotRowSeq += 1;
  return `lot-row-${lotRowSeq}`;
}

/**
 * The "choose specific lots" override for one (material, warehouse) pair.
 * Mounted (and, on a pair change, fully REmounted via the parent's `key`)
 * only once both are chosen -- see IssueMaterialForm below. Remounting on
 * every pair change is what resets the override checkbox and any rows from
 * a previous selection; a plain effect that setState'd on every dependency
 * change would do the same reset, but synchronously inside the effect body,
 * which is exactly the extra-render anti-pattern
 * react-hooks/set-state-in-effect flags -- the fetch below still runs in an
 * effect, but it only ever setState from inside the async `.then()`, never
 * synchronously in the effect body itself.
 */
function LotAllocationFields({
  materialId,
  warehouseId,
  uom,
  disabled,
  error,
  onChange,
}: {
  materialId: string;
  warehouseId: string;
  uom?: string;
  disabled: boolean;
  error?: string;
  onChange: (allocations: LotAllocationInput[] | undefined) => void;
}) {
  const [availableLots, setAvailableLots] = useState<{ state: "loading" | "ok" | "error"; lots: MaterialLot[] }>({ state: "loading", lots: [] });
  const [overrideLots, setOverrideLots] = useState(false);
  const [lotRows, setLotRows] = useState<LotAllocationRow[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<MaterialLot[]>(`/api/v1/inventory/lots/available?itemId=${materialId}&warehouseId=${warehouseId}`, { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return;
      setAvailableLots(r.ok ? { state: "ok", lots: r.data } : { state: "error", lots: [] });
    });
    return () => controller.abort();
  }, [materialId, warehouseId]);

  useEffect(() => {
    if (!overrideLots || lotRows.length === 0) return onChange(undefined);
    const rows = lotRows.filter((r) => r.lotId && r.quantity.trim() !== "");
    if (rows.length !== lotRows.length) return onChange(undefined);
    onChange(rows.map((r) => ({ lotId: r.lotId, quantity: Number(r.quantity) })));
    // onChange is a plain setter from the parent, stable enough not to need listing; re-running on it would just re-send the same value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideLots, lotRows]);

  if (availableLots.state === "loading") return <p className="text-sm text-muted-foreground">Checking whether this material is lot-tracked…</p>;
  if (availableLots.state === "error") return <Notice tone="danger">Couldn&apos;t check this material&apos;s lots. You can still issue it -- the system will auto-allocate.</Notice>;
  if (availableLots.lots.length === 0) return null; // not lot-tracked in this warehouse

  function addLotRow() {
    setLotRows((rows) => [...rows, { key: newLotRowKey(), lotId: "", quantity: "" }]);
  }
  function setLotRow(key: string, patch: Partial<LotAllocationRow>) {
    setLotRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeLotRow(key: string) {
    setLotRows((rows) => rows.filter((r) => r.key !== key));
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={overrideLots}
          disabled={disabled}
          onChange={(e) => {
            setOverrideLots(e.target.checked);
            if (!e.target.checked) setLotRows([]);
          }}
          className="size-4 rounded border-border"
        />
        Choose specific lots
      </label>
      <p className="text-xs text-muted-foreground">
        This material is lot-tracked. By default the earliest-expiring stock is drawn from automatically. Turn this on only to draw from a specific lot instead.
      </p>
      {overrideLots ? (
        <div className="space-y-2">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {lotRows.map((row) => {
            const chosenElsewhere = new Set(lotRows.filter((r) => r.key !== row.key).map((r) => r.lotId));
            return (
              <div key={row.key} className="flex flex-wrap items-end gap-2">
                <Field id={`lot-${row.key}`} label="Lot" className="min-w-48 flex-1">
                  <Select id={`lot-${row.key}`} value={row.lotId} disabled={disabled} onChange={(e) => setLotRow(row.key, { lotId: e.target.value })}>
                    <option value="">Choose lot…</option>
                    {availableLots.lots
                      .filter((l) => l.available && !chosenElsewhere.has(l.id))
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.lotNumber} — {formatQuantity(l.remaining, l.uom)} left{l.expiryDate ? ` · expires ${l.expiryDate.slice(0, 10)}` : ""}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field id={`lotqty-${row.key}`} label={`Quantity${uom ? ` (${uom})` : ""}`} className="w-40">
                  <Input id={`lotqty-${row.key}`} inputMode="decimal" disabled={disabled} value={row.quantity} onChange={(e) => setLotRow(row.key, { quantity: e.target.value })} />
                </Field>
                <Button type="button" variant="outline" disabled={disabled} onClick={() => removeLotRow(row.key)}>
                  Remove
                </Button>
              </div>
            );
          })}
          <Button type="button" variant="outline" disabled={disabled} onClick={addLotRow}>
            Add lot
          </Button>
        </div>
      ) : null}
    </div>
  );
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
  canPickLots = false,
  onIssued,
}: {
  jobId: string;
  materials: IssueMaterialOption[];
  warehouses: WarehouseOption[];
  /** Renders the "choose specific lots" override. See lot-service.ts's header for why this is gated on lot:read, not material:issue -- an operator without it still issues lot-tracked material fine, just always via server-side FEFO auto-allocation. */
  canPickLots?: boolean;
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
  const [lotAllocations, setLotAllocations] = useState<LotAllocationInput[] | undefined>(undefined);
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

    if (lotAllocations) {
      const seen = new Set<string>();
      let sum = 0;
      for (const a of lotAllocations) {
        if (seen.has(a.lotId)) problems.lotAllocations = "Each lot can only be used once.";
        seen.add(a.lotId);
        sum += a.quantity;
      }
      if (!problems.lotAllocations && q.ok && Math.abs(sum - q.value) > 1e-6) {
        problems.lotAllocations = `Lot quantities (${sum}) must add up to the issue quantity (${q.value}).`;
      }
    }

    setLocal(problems);
    if (Object.keys(problems).length || !q.ok) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { materialItemId: materialId, warehouseId, quantity: q.value, ...(lotAllocations ? { lotAllocations } : {}) };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(
      () => apiRequest(`/api/v1/production-jobs/${jobId}/material-issues`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }),
      { idempotency: idem.current, visibleFields: ["materialItemId", "warehouseId", "quantity", "lotAllocations"] },
    );
    if (result?.ok) {
      setDone({ text: `Issued ${formatQuantity(String(q.value), material?.uom)} of ${material?.label ?? "material"}.`, replayed: result.replayed });
      setQty("");
      setLotAllocations(undefined);
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
        <Select
          id="iss-material"
          value={materialId}
          onChange={(e) => {
            setMaterialId(e.target.value);
            setOnHand({ state: "idle" });
            setLotAllocations(undefined);
          }}
          aria-invalid={Boolean(errors.materialItemId) || undefined}
          aria-describedby={describedBy("iss-material", { error: errors.materialItemId })}
        >
          <option value="">Choose material…</option>
          {materials.map((m) => (
            <option key={m.materialItemId} value={m.materialItemId}>
              {m.label} — {formatQuantity(m.remainingQty, m.uom)} still needed
            </option>
          ))}
        </Select>
      </Field>
      <Field id="iss-wh" label="From warehouse" required error={errors.warehouseId} hint={stockLine ?? undefined}>
        <Select
          id="iss-wh"
          value={warehouseId}
          onChange={(e) => {
            setWarehouseId(e.target.value);
            setOnHand({ state: "idle" });
            setLotAllocations(undefined);
          }}
          aria-invalid={Boolean(errors.warehouseId) || undefined}
          aria-describedby={describedBy("iss-wh", { error: errors.warehouseId, hint: stockLine ?? undefined })}
        >
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

      {canPickLots && hasPair ? (
        <LotAllocationFields
          key={`${materialId}:${warehouseId}`}
          materialId={materialId}
          warehouseId={warehouseId}
          uom={material?.uom}
          disabled={sub.pending}
          error={errors.lotAllocations}
          onChange={setLotAllocations}
        />
      ) : null}

      <SubmitButton pending={sub.pending} pendingLabel="Issuing…">
        Issue material
      </SubmitButton>
    </form>
  );
}
