"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { LocalTime } from "@/components/ui/local-time";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { IdempotentRequest } from "@/lib/idempotency";
import type { MachineTimeEntry, MachineTimeList } from "@/lib/api-types";

// Records actual setup/run minutes against a machine, optionally attributed
// to a stage. Unlike labour (no list endpoint yet), machine time DOES have a
// real history endpoint, so the table below reflects the server, not just
// what was recorded in this browser session.
export function MachineTimeForm({
  jobId,
  machines,
  stages,
  list,
  nameOf,
  canRecord = true,
}: {
  jobId: string;
  machines: { id: string; name: string; code: string }[];
  stages: { id: string; label: string }[];
  list: MachineTimeList;
  nameOf: (id: string | null) => string;
  /** false hides the recording form entirely (read-only history view). */
  canRecord?: boolean;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const idem = useRef(new IdempotentRequest());
  const [machineId, setMachineId] = useState(machines.length === 1 ? machines[0]!.id : "");
  const [stageId, setStageId] = useState("");
  const [setupMinutes, setSetupMinutes] = useState("");
  const [runMinutes, setRunMinutes] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };
  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? "Machine";
  const stageName = (id: string | null) => (id ? (stages.find((s) => s.id === id)?.label ?? "Stage") : "Whole job");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!machineId) problems.machineId = "Choose a machine.";
    const setup = setupMinutes.trim() === "" ? 0 : Number(setupMinutes);
    const run = runMinutes.trim() === "" ? 0 : Number(runMinutes);
    if (setupMinutes.trim() !== "" && (!Number.isInteger(setup) || setup < 0 || setup > 1440)) problems.setupMinutes = "Must be a whole number of minutes, 0–1440.";
    if (runMinutes.trim() !== "" && (!Number.isInteger(run) || run < 0 || run > 1440)) problems.runMinutes = "Must be a whole number of minutes, 0–1440.";
    if (!problems.setupMinutes && !problems.runMinutes && setup + run <= 0) problems.runMinutes = "Record at least one setup or run minute.";
    setLocal(problems);
    if (Object.keys(problems).length) return sub.fail("Fix the highlighted fields and try again.");

    const payload = { machineId, ...(stageId ? { jobStageId: stageId } : {}), setupMinutes: setup, runMinutes: run };
    const prepared = idem.current.prepare(payload);
    if (!prepared.ok) return sub.fail(prepared.reason);

    const result = await sub.run(() => apiRequest<MachineTimeEntry>(`/api/v1/production-jobs/${jobId}/machine-time`, { method: "POST", body: { clientRequestId: prepared.clientRequestId, ...payload } }), {
      idempotency: idem.current,
      visibleFields: ["machineId", "jobStageId", "setupMinutes", "runMinutes"],
    });
    if (result?.ok) {
      setSetupMinutes("");
      setRunMinutes("");
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      {!canRecord ? null : machines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No machines are registered for this branch yet.</p>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-4">
          <div className="sm:col-span-4">
            <FormError message={sub.error} />
          </div>
          <Field id="mt-machine" label="Machine" required error={errors.machineId}>
            <Select id="mt-machine" value={machineId} onChange={(e) => setMachineId(e.target.value)} aria-invalid={Boolean(errors.machineId) || undefined} aria-describedby={describedBy("mt-machine", { error: errors.machineId })}>
              <option value="">Choose machine…</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.code})
                </option>
              ))}
            </Select>
          </Field>
          {stages.length > 0 ? (
            <Field id="mt-stage" label="Stage" hint="Optional">
              <Select id="mt-stage" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                <option value="">Whole job</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field id="mt-setup" label="Setup (min)" error={errors.setupMinutes}>
            <Input id="mt-setup" inputMode="numeric" value={setupMinutes} onChange={(e) => setSetupMinutes(e.target.value)} aria-invalid={Boolean(errors.setupMinutes) || undefined} />
          </Field>
          <Field id="mt-run" label="Run (min)" error={errors.runMinutes}>
            <Input id="mt-run" inputMode="numeric" value={runMinutes} onChange={(e) => setRunMinutes(e.target.value)} aria-invalid={Boolean(errors.runMinutes) || undefined} />
          </Field>
          <div className="sm:col-span-4">
            <SubmitButton pending={sub.pending} pendingLabel="Recording…">
              Record machine time
            </SubmitButton>
          </div>
        </form>
      )}

      {list.entries.length > 0 ? (
        <Table>
          <THead>
            <tr>
              <TH>When</TH>
              <TH>Machine</TH>
              <TH>Stage</TH>
              <TH className="text-right">Setup (min)</TH>
              <TH className="text-right">Run (min)</TH>
              <TH>Operator</TH>
            </tr>
          </THead>
          <TBody>
            {list.entries.map((e) => (
              <TR key={e.id}>
                <TD><LocalTime iso={e.recordedAt} /></TD>
                <TD>{machineName(e.machineId)}</TD>
                <TD>{stageName(e.jobStageId)}</TD>
                <TD className="text-right tabular-nums">{e.setupMinutes}</TD>
                <TD className="text-right tabular-nums">{e.runMinutes}</TD>
                <TD>{nameOf(e.operatorUserId)}</TD>
              </TR>
            ))}
          </TBody>
          <tfoot>
            <TR>
              <TD colSpan={3} className="text-right text-xs font-medium text-muted-foreground">Total</TD>
              <TD className="text-right font-medium tabular-nums">{list.totals.setupMinutes}</TD>
              <TD className="text-right font-medium tabular-nums">{list.totals.runMinutes}</TD>
              <TD></TD>
            </TR>
          </tfoot>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No machine time has been recorded for this job yet.</p>
      )}
    </div>
  );
}
