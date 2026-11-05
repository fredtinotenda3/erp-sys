"use client";

import { useState } from "react";

import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { ReturnMaterialForm, type ReturnMaterialOption } from "./return-material-form";
import { apiRequest } from "@/lib/api-client";
import type { JobLotConsumptionRow, JobMaterialRow } from "@/lib/api-types";

export interface ReturnJobOption {
  id: string;
  label: string;
  branchId: string;
}

type Loaded =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ok"; jobId: string; materials: JobMaterialRow[]; lots: JobLotConsumptionRow[] };

// Inventory-side entry to "return material from a job": pick the job, see
// what's currently issued and not yet returned, then (if that material was
// lot-tracked) say which lot(s) it traces back to. Mirrors IssueWorkflow.
export function ReturnWorkflow({
  jobs,
  warehouses,
  itemNames,
}: {
  jobs: ReturnJobOption[];
  warehouses: { id: string; name: string; branchId: string }[];
  itemNames: Record<string, string>;
}) {
  const [jobId, setJobId] = useState("");
  const [materialId, setMaterialId] = useState("");
  const [data, setData] = useState<Loaded>({ state: "idle" });

  async function load(id: string) {
    setMaterialId("");
    if (!id) return setData({ state: "idle" });
    setData({ state: "loading" });
    const [matRes, lotRes] = await Promise.all([
      apiRequest<JobMaterialRow[]>(`/api/v1/production-jobs/${id}/materials`),
      apiRequest<JobLotConsumptionRow[]>(`/api/v1/production-jobs/${id}/material-lots`),
    ]);
    if (!matRes.ok) return setData({ state: "error", message: matRes.error.message });
    // A role without lot:read sees 403 on material-lots -- that's fine, it
    // just means this job's returns are handled as not-lot-tracked (the
    // server is still authoritative and will reject a lot-tracked return
    // submitted without lotReturns, same as if this list were genuinely
    // empty).
    setData({ state: "ok", jobId: id, materials: matRes.data, lots: lotRes.ok ? lotRes.data : [] });
  }

  const job = jobs.find((j) => j.id === jobId);
  const branchWarehouses = warehouses.filter((w) => job && w.branchId === job.branchId).map((w) => ({ id: w.id, name: w.name }));

  const returnable: ReturnMaterialOption[] =
    data.state === "ok"
      ? data.materials
          .filter((m) => Number(m.issuedQty) > 0)
          .map((m) => ({ materialItemId: m.materialItemId, label: itemNames[m.materialItemId] ?? `Item ${m.materialItemId.slice(0, 8)}`, uom: m.uom, outstandingQty: m.issuedQty }))
      : [];
  const material = returnable.find((m) => m.materialItemId === materialId);
  const lotsForMaterial = data.state === "ok" && material ? data.lots.filter((l) => l.itemId === material.materialItemId) : [];
  const lotWarehouseIds = new Set(lotsForMaterial.map((l) => l.warehouseId));
  const warehousesForMaterial = lotsForMaterial.length > 0 ? branchWarehouses.filter((w) => lotWarehouseIds.has(w.id)) : branchWarehouses;

  return (
    <div className="max-w-xl space-y-4">
      <Field id="rw-job" label="Production job" required hint="Only material already issued to a job can be returned.">
        <Select
          id="rw-job"
          value={jobId}
          onChange={(e) => {
            setJobId(e.target.value);
            void load(e.target.value);
          }}
        >
          <option value="">Choose job…</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.label}
            </option>
          ))}
        </Select>
      </Field>
      {data.state === "loading" ? <p role="status" className="text-sm text-muted-foreground">Loading what&apos;s been issued to this job…</p> : null}
      {data.state === "error" ? <Notice tone="danger">{data.message}</Notice> : null}
      {data.state === "ok" && data.jobId === jobId ? (
        returnable.length === 0 ? (
          <Notice tone="neutral">This job has nothing currently issued that hasn&apos;t already been returned.</Notice>
        ) : (
          <>
            <Field id="rw-material" label="Material" required>
              <Select id="rw-material" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
                <option value="">Choose material…</option>
                {returnable.map((m) => (
                  <option key={m.materialItemId} value={m.materialItemId}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            {material ? (
              warehousesForMaterial.length === 0 ? (
                <Notice tone="warning">No warehouse in this job&apos;s branch can accept this return.</Notice>
              ) : (
                <ReturnMaterialForm
                  key={`${jobId}:${materialId}`}
                  jobId={jobId}
                  material={material}
                  warehouses={warehousesForMaterial}
                  lotsForMaterial={lotsForMaterial}
                  onReturned={() => void load(jobId)}
                />
              )
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
