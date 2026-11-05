"use client";

import { useState } from "react";
import { PackagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { ReturnMaterialForm, type ReturnMaterialOption } from "@/components/features/inventory/return-material-form";
import type { JobLotConsumptionRow } from "@/lib/api-types";

// Job-detail-page entry to "return material from THIS job" -- same form the
// dedicated /inventory/return page uses, but with the job already fixed and
// a one-step material picker instead of the standalone page's job+material
// picker (see return-workflow.tsx).
export function ReturnMaterialDialog({
  jobId,
  jobNumber,
  materials,
  warehouses,
  lots,
}: {
  jobId: string;
  jobNumber: string;
  materials: ReturnMaterialOption[];
  warehouses: { id: string; name: string }[];
  lots: JobLotConsumptionRow[];
}) {
  const [open, setOpen] = useState(false);
  const [materialId, setMaterialId] = useState("");
  const material = materials.find((m) => m.materialItemId === materialId);
  const lotsForMaterial = material ? lots.filter((l) => l.itemId === material.materialItemId) : [];
  const lotWarehouseIds = new Set(lotsForMaterial.map((l) => l.warehouseId));
  const warehousesForMaterial = lotsForMaterial.length > 0 ? warehouses.filter((w) => lotWarehouseIds.has(w.id)) : warehouses;

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <PackagePlus /> Return material
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Return material from ${jobNumber}`} description="Puts unused or rejected material back into stock.">
        <div className="space-y-4">
          <Field id="rmd-material" label="Material" required>
            <Select id="rmd-material" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
              <option value="">Choose material…</option>
              {materials.map((m) => (
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
                onReturned={() => setOpen(false)}
              />
            )
          ) : null}
        </div>
      </Modal>
    </>
  );
}
