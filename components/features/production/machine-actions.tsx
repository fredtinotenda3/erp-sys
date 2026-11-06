"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CircleCheck, Wrench } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { MachineStatus } from "@/lib/api-types";

const DOWNTIME_CATEGORIES = [
  { value: "breakdown", label: "Breakdown" },
  { value: "changeover", label: "Changeover" },
  { value: "no_material", label: "No material" },
  { value: "no_operator", label: "No operator" },
  { value: "planned_maintenance", label: "Planned maintenance" },
  { value: "other", label: "Other" },
] as const;

// All actions for one machine: open/close downtime, schedule/complete
// maintenance, and the direct status setter for the transitions that aren't
// tied to a downtime record (available <-> in_use, or retiring). "down" is
// deliberately NOT offered here -- machine-service.ts rejects setting it
// directly; it only ever comes from opening a downtime record, below.
export function MachineActions({
  machineId,
  status,
  openDowntimeId,
  canManage,
}: {
  machineId: string;
  status: MachineStatus;
  openDowntimeId: string | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [dialog, setDialog] = useState<"downtime" | "close_downtime" | "maintenance" | "complete_maintenance" | null>(null);
  const [category, setCategory] = useState<(typeof DOWNTIME_CATEGORIES)[number]["value"]>("breakdown");
  const [reason, setReason] = useState("");
  const [maintenanceType, setMaintenanceType] = useState<"scheduled" | "unscheduled">("scheduled");
  const [scheduledAt, setScheduledAt] = useState("");
  const [notes, setNotes] = useState("");

  const close = () => {
    if (sub.pending) return;
    setDialog(null);
    sub.clear();
    setReason("");
    setNotes("");
    setScheduledAt("");
  };

  async function submitDowntime() {
    if (reason.trim().length < 3) return sub.fail("Give a brief reason (at least 3 characters).", { reason: "Give a brief reason (at least 3 characters)." });
    const r = await sub.run(() => apiRequest(`/api/v1/machines/${machineId}/downtime`, { method: "POST", body: { category, reason: reason.trim() } }), { visibleFields: ["category", "reason"] });
    if (r?.ok) { close(); router.refresh(); }
  }

  async function submitCloseDowntime() {
    if (!openDowntimeId) return;
    const r = await sub.run(() => apiRequest(`/api/v1/machines/${machineId}/downtime/${openDowntimeId}/close`, { method: "POST", body: notes.trim() ? { notes: notes.trim() } : {} }));
    if (r?.ok) { close(); router.refresh(); }
  }

  async function submitMaintenance() {
    if (maintenanceType === "scheduled" && !scheduledAt) return sub.fail("Choose a scheduled date and time.", { scheduledAt: "Choose a scheduled date and time." });
    const r = await sub.run(
      () =>
        apiRequest(`/api/v1/machines/${machineId}/maintenance`, {
          method: "POST",
          body: { type: maintenanceType, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined, notes: notes.trim() || undefined },
        }),
      { visibleFields: ["type", "scheduledAt", "notes"] },
    );
    if (r?.ok) { close(); router.refresh(); }
  }

  async function setStatus(next: "available" | "in_use" | "retired") {
    const r = await sub.run(() => apiRequest(`/api/v1/machines/${machineId}`, { method: "PATCH", body: { status: next } }));
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
      {status !== "down" && status !== "retired" ? (
        <Button variant="outline" size="sm" onClick={() => setDialog("downtime")}>
          <AlertTriangle /> Log downtime
        </Button>
      ) : null}
      {status === "down" && openDowntimeId ? (
        <Button size="sm" onClick={() => setDialog("close_downtime")}>
          <CircleCheck /> Close downtime
        </Button>
      ) : null}
      {status !== "retired" ? (
        <Button variant="outline" size="sm" onClick={() => setDialog("maintenance")}>
          <Wrench /> Schedule maintenance
        </Button>
      ) : null}
      {status !== "retired" ? (
        <Button variant="outline" size="sm" disabled={sub.pending} onClick={() => void setStatus("retired")}>
          Retire machine
        </Button>
      ) : null}

      <Modal
        open={dialog === "downtime"}
        onClose={close}
        title="Log downtime"
        description="This marks the machine as down immediately."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Cancel</Button><SubmitButton pending={sub.pending} pendingLabel="Logging…" form="downtime-form">Log downtime</SubmitButton></>}
      >
        <form id="downtime-form" onSubmit={(e) => { e.preventDefault(); void submitDowntime(); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="downtime-category" label="Category" required>
            <Select id="downtime-category" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {DOWNTIME_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </Select>
          </Field>
          <Field id="downtime-reason" label="Reason" required error={sub.fieldErrors.reason}>
            <Textarea id="downtime-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={describedBy("downtime-reason", { error: sub.fieldErrors.reason })} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === "close_downtime"}
        onClose={close}
        title="Close downtime"
        description="This restores the machine to available."
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Cancel</Button><SubmitButton pending={sub.pending} pendingLabel="Closing…" form="close-downtime-form">Close downtime</SubmitButton></>}
      >
        <form id="close-downtime-form" onSubmit={(e) => { e.preventDefault(); void submitCloseDowntime(); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="close-downtime-notes" label="Notes" hint="Optional">
            <Textarea id="close-downtime-notes" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </form>
      </Modal>

      <Modal
        open={dialog === "maintenance"}
        onClose={close}
        title="Schedule maintenance"
        footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Cancel</Button><SubmitButton pending={sub.pending} pendingLabel="Scheduling…" form="maintenance-form">Schedule</SubmitButton></>}
      >
        <form id="maintenance-form" onSubmit={(e) => { e.preventDefault(); void submitMaintenance(); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="maintenance-type" label="Type" required>
            <Select id="maintenance-type" value={maintenanceType} onChange={(e) => setMaintenanceType(e.target.value as typeof maintenanceType)}>
              <option value="scheduled">Scheduled</option>
              <option value="unscheduled">Unscheduled</option>
            </Select>
          </Field>
          {maintenanceType === "scheduled" ? (
            <Field id="maintenance-date" label="Scheduled for" required error={sub.fieldErrors.scheduledAt}>
              <Input id="maintenance-date" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} aria-describedby={describedBy("maintenance-date", { error: sub.fieldErrors.scheduledAt })} />
            </Field>
          ) : null}
          <Field id="maintenance-notes" label="Notes" hint="Optional">
            <Textarea id="maintenance-notes" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}

export function CompleteMaintenanceButton({ machineId, maintenanceId, canManage }: { machineId: string; maintenanceId: string; canManage: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const close = () => { if (!sub.pending) { setOpen(false); sub.clear(); setNotes(""); } };

  async function submit() {
    const r = await sub.run(() => apiRequest(`/api/v1/machines/${machineId}/maintenance/${maintenanceId}/complete`, { method: "POST", body: notes.trim() ? { notes: notes.trim() } : {} }));
    if (r?.ok) { close(); router.refresh(); }
  }

  if (!canManage) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <CircleCheck /> Complete
      </Button>
      <Modal open={open} onClose={close} title="Complete maintenance" footer={<><Button variant="outline" onClick={close} disabled={sub.pending}>Cancel</Button><SubmitButton pending={sub.pending} pendingLabel="Completing…" form="complete-maintenance-form">Complete</SubmitButton></>}>
        <form id="complete-maintenance-form" onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-3">
          <FormError message={sub.error} />
          <Field id="complete-maintenance-notes" label="Notes" hint="Optional">
            <Textarea id="complete-maintenance-notes" rows={3} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </>
  );
}
