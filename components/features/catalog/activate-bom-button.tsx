"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";

export function ActivateBomButton({ itemId, bomId, version, activeVersion }: { itemId: string; bomId: string; version: number; activeVersion: number | null }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);

  function close() {
    if (sub.pending) return;
    setOpen(false);
    sub.clear();
  }

  async function confirm() {
    const result = await sub.run(() => apiRequest(`/api/v1/items/${itemId}/boms/${bomId}/activate`, { method: "POST" }));
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Activate
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        size="sm"
        title={`Activate version ${version}?`}
        description={
          <>
            New jobs will use version {version}.
            {activeVersion !== null ? ` Version ${activeVersion} becomes superseded and can't be reactivated.` : ""} Jobs already created keep the version they were
            created with.
          </>
        }
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close} disabled={sub.pending}>
              Cancel
            </Button>
            <Button type="button" onClick={confirm} disabled={sub.pending} aria-busy={sub.pending}>
              {sub.pending ? "Activating…" : `Activate version ${version}`}
            </Button>
          </>
        }
      >
        <FormError message={sub.error} />
      </Modal>
    </>
  );
}
