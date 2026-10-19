"use client";

import { useState } from "react";
import { PackageMinus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { IssueMaterialForm, type IssueMaterialOption, type WarehouseOption } from "@/components/features/inventory/issue-material-form";

export function IssueMaterialDialog({ jobId, jobNumber, materials, warehouses }: { jobId: string; jobNumber: string; materials: IssueMaterialOption[]; warehouses: WarehouseOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <PackageMinus /> Issue material
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Issue material to ${jobNumber}`} description="Takes stock out of a warehouse and charges it to this job.">
        <IssueMaterialForm jobId={jobId} materials={materials} warehouses={warehouses} />
      </Modal>
    </>
  );
}
