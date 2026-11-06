"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { MouldStatus } from "@/lib/api-types";

// Status transitions + maintenance for one mould. Mirrors machine-actions.tsx's
// shape, trimmed to what a mould actually has: no "down" state (a mould
// doesn't break mid-run the way a machine can -- a damaged mould goes
// straight to "maintenance" by hand, there is no downtime record for it).
export function MouldActions({ mouldId, status, canManage }: { mouldId: string; status: MouldStatus; canManage: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [dialog, setDialog] = useState<"maintenance" | null>(null);
  const [maintenanceType, setMaintenanceType] = useState<"scheduled" | "unscheduled">("scheduled");
  const [scheduledAt, setScheduledAt] = useState("");
  const [notes, setNotes] = useState("");

  const close = () => {
    if (sub.pending) return;
    setDialog(null);
    sub.clear();
    setNotes("");
    setScheduledAt("");
  };

  async function submitMaintenance() {
    if (maintenanceType === "scheduled" && !scheduledAt) return sub.fail("Choose a scheduled date and time.", { scheduledAt: "Choose a scheduled date and time." });
    const r = await sub.run(
      () =>
        apiRequest(`/api/v1/moulds/${mouldId}/maintenance`, {
          method: "POST",
          body: { type: maintenanceType, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined, notes: notes.trim() || undefined },
        }),
      { visibleFields: ["type", "scheduledAt", "notes"] },
    );
    if (r?.ok) { close(); router.refresh(); }
  }

  async function setStatus(next: "available" | "in_use" | "retired") {
    const r = await sub.run(() => apiRequest(`/api/v1/moulds/${mouldId}`, { method: "PATCH", body: { status: next } }));
    if (r?.ok) router.refresh();
  }

  if (!canManage) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "available" ? (
        <Button variant="outline" size="sm" disabled={sub.pending} onClick={() => void setStatus("in_use")}>
          <CircleCheck /> Mark in use
        </Button>
      ) : null}
      {status === "in_use" ? (
        <Button variant="outline" size="sm" disabled={sub.pending} onClick={() => void setStatus("available")}>
          <CircleCheck /> Mark available
        </Button>
      ) : null}
      {status !== "retired" ? (
        <Button variant="outline" size="sm" onClick={() => setDialog("maintenance")}>
          <Wrench /> Schedule maintenance
        </Button>
      ) : null}
      {status !== "retired" ? (
        <Button variant="outline" size="sm" disabled={sub.pending} onClick={() => void setStatus("retired")}>
          Retire mould
        </Button>
      ) : null}

      <Modal
        open={dialog === "maintenance"}
        onClose={close}
        title="Schedule maintenance"
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Cancel</Button><SubmitButton pending={sub.pending} pendingLabel="Scheduling…" form="mould-maintenance-form">Schedule</SubmitButton></>}
      >
        <form id="mould-maintenance-form" onSubmit={(e) => { e.preventDefault(); void submitMaintenance(); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="mould-maintenance-type" label="Type" required>
            <Select id="mould-maintenance-type" value={maintenanceType} onChange={(e) => setMaintenanceType(e.target.value as typeof maintenanceType)}>
              <option value="scheduled">Scheduled</option>
              <option value="unscheduled">Unscheduled</option>
            </Select>
          </Field>
          {maintenanceType === "scheduled" ? (
            <Field id="mould-maintenance-date" label="Scheduled for" required error={sub.fieldErrors.scheduledAt}>
              <Input id="mould-maintenance-date" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} aria-describedby={describedBy("mould-maintenance-date", { error: sub.fieldErrors.scheduledAt })} />
            </Field>
          ) : null}
          <Field id="mould-maintenance-notes" label="Notes" hint="Optional">
            <Textarea id="mould-maintenance-notes" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}

export function CompleteMouldMaintenanceButton({ mouldId, maintenanceId, canManage }: { mouldId: string; maintenanceId: string; canManage: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const close = () => { if (!sub.pending) { setOpen(false); sub.clear(); setNotes(""); } };

  async function submit() {
    const r = await sub.run(() => apiRequest(`/api/v1/moulds/${mouldId}/maintenance/${maintenanceId}/complete`, { method: "POST", body: notes.trim() ? { notes: notes.trim() } : {} }));
    if (r?.ok) { close(); router.refresh(); }
  }

  if (!canManage) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <CircleCheck /> Complete
      </Button>
      <Modal open={open} onClose={close} title="Complete maintenance" footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Cancel</Button><SubmitButton pending={sub.pending} pendingLabel="Completing…" form="complete-mould-maintenance-form">Complete</SubmitButton></>}>
        <form id="complete-mould-maintenance-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="complete-mould-maintenance-notes" label="Notes" hint="Optional">
            <Textarea id="complete-mould-maintenance-notes" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </>
  );
}

/** Add/remove a compatible machine for one mould. */
export function MouldMachineCompatibilityForm({ mouldId, compatibleMachineIds, machines, canManage }: { mouldId: string; compatibleMachineIds: string[]; machines: { id: string; name: string; code: string }[]; canManage: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [machineId, setMachineId] = useState("");
  const available = machines.filter((m) => !compatibleMachineIds.includes(m.id));

  async function add() {
    if (!machineId) return sub.fail("Choose a machine.");
    const r = await sub.run(() => apiRequest(`/api/v1/moulds/${mouldId}/compatible-machines`, { method: "POST", body: { machineId } }));
    if (r?.ok) { setMachineId(""); router.refresh(); }
  }

  async function remove(id: string) {
    const r = await sub.run(() => apiRequest(`/api/v1/moulds/${mouldId}/compatible-machines/${id}`, { method: "DELETE" }));
    if (r?.ok) router.refresh();
  }

  return (
    <div className="space-y-2">
      <FormError message={sub.error} />
      {compatibleMachineIds.length === 0 ? (
        <p className="text-sm text-muted-foreground">No compatible machines registered yet.</p>
      ) : (
        <ul className="space-y-1">
          {compatibleMachineIds.map((id) => {
            const m = machines.find((x) => x.id === id);
            return (
              <li key={id} className="flex items-center justify-between gap-2 text-sm">
                <span>{m ? `${m.name} (${m.code})` : `Machine ${id.slice(0, 8)}`}</span>
                {canManage ? (
                  <Button variant="ghost" size="sm" disabled={sub.pending} onClick={() => void remove(id)}>Remove</Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {canManage && available.length > 0 ? (
        <div className="flex items-end gap-2 pt-2">
          <Field id="mould-add-machine" label="Add compatible machine">
            <Select id="mould-add-machine" value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              <option value="">Choose machine…</option>
              {available.map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({m.code})</option>
              ))}
            </Select>
          </Field>
          <Button type="button" variant="outline" size="sm" disabled={sub.pending} onClick={() => void add()}>Add</Button>
        </div>
      ) : null}
    </div>
  );
}
