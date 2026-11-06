"use client";

import { useState } from "react";
import { PackagePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ReceiveFinishedGoodsForm, type FgWarehouseOption } from "@/components/features/inventory/receive-finished-goods-form";

export function ReceiveFinishedGoodsDialog({
  jobId,
  jobNumber,
  uom,
  uncommittedGoodQty,
  warehouses,
}: {
  jobId: string;
  jobNumber: string;
  uom: string;
  uncommittedGoodQty: string;
  warehouses: FgWarehouseOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        <PackagePlus /> Receive to finished goods
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Receive finished goods for ${jobNumber}`}
        description="Converts good output this job has already recorded into valued, traceable finished-goods stock."
      >
        <ReceiveFinishedGoodsForm jobId={jobId} uom={uom} uncommittedGoodQty={uncommittedGoodQty} warehouses={warehouses} />
      </Modal>
    </>
  );
}
