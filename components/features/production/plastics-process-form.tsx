"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { PlasticsProcessDetailView } from "@/lib/api-types";

function numOrUndef(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const SUGGESTED_PROCESS_TYPES = ["injection_moulding", "blow_moulding", "isbm", "preform_production", "bottle_production", "cap_closure_production"];

/**
 * One job stage's plastics process detail: process type, mould, target/
 * actual cycle time, cavity counts. Locked once the stage is completed (the
 * server enforces this; the form here just disables itself for a tidier UX
 * when it already knows that from the stage's own status).
 */
export function PlasticsProcessForm({
  jobId,
  jobStageId,
  stageName,
  stageCompleted,
  initial,
  moulds,
  canRecord,
}: {
  jobId: string;
  jobStageId: string;
  stageName: string;
  stageCompleted: boolean;
  initial: PlasticsProcessDetailView | null;
  moulds: { id: string; name: string; code: string }[];
  canRecord: boolean;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [processType, setProcessType] = useState(initial?.processType ?? "");
  const [mouldId, setMouldId] = useState(initial?.mouldId ?? "");
  const [targetCycleTimeSeconds, setTargetCycleTimeSeconds] = useState(initial?.targetCycleTimeSeconds ?? "");
  const [actualCycleTimeSeconds, setActualCycleTimeSeconds] = useState(initial?.actualCycleTimeSeconds ?? "");
  const [totalCavities, setTotalCavities] = useState(initial?.totalCavities?.toString() ?? "");
  const [goodCavities, setGoodCavities] = useState(initial?.goodCavities?.toString() ?? "");

  const disabled = !canRecord || stageCompleted;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!processType.trim()) return sub.fail("Process type is required.", { processType: "Required." });
    const result = await sub.run(() =>
      apiRequest(`/api/v1/production-jobs/${jobId}/stages/${jobStageId}/plastics-process-detail`, {
        method: "PUT",
        body: {
          processType: processType.trim(),
          mouldId: mouldId || null,
          targetCycleTimeSeconds: numOrUndef(String(targetCycleTimeSeconds)) ?? null,
          actualCycleTimeSeconds: numOrUndef(String(actualCycleTimeSeconds)) ?? null,
          totalCavities: numOrUndef(totalCavities) ?? null,
          goodCavities: numOrUndef(goodCavities) ?? null,
        },
      }),
      { visibleFields: ["processType", "mouldId", "targetCycleTimeSeconds", "actualCycleTimeSeconds", "totalCavities", "goodCavities"] },
    );
    if (result?.ok) router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-3 sm:grid-cols-3">
      <div className="sm:col-span-3"><FormError message={sub.error} /></div>
      <Field id={`pp-type-${jobStageId}`} label={`${stageName} — process type`} required error={sub.fieldErrors.processType}>
        <Input id={`pp-type-${jobStageId}`} list={`pp-type-list-${jobStageId}`} value={processType} onChange={(e) => setProcessType(e.target.value)} disabled={disabled} maxLength={60} />
        <datalist id={`pp-type-list-${jobStageId}`}>
          {SUGGESTED_PROCESS_TYPES.map((t) => <option key={t} value={t} />)}
        </datalist>
      </Field>
      <Field id={`pp-mould-${jobStageId}`} label="Mould">
        <Select id={`pp-mould-${jobStageId}`} value={mouldId} onChange={(e) => setMouldId(e.target.value)} disabled={disabled}>
          <option value="">Not set</option>
          {moulds.map((m) => (
            <option key={m.id} value={m.id}>{m.name} ({m.code})</option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field id={`pp-target-ct-${jobStageId}`} label="Target cycle (s)">
          <Input id={`pp-target-ct-${jobStageId}`} type="number" min="0" step="0.01" value={targetCycleTimeSeconds} onChange={(e) => setTargetCycleTimeSeconds(e.target.value)} disabled={disabled} />
        </Field>
        <Field id={`pp-actual-ct-${jobStageId}`} label="Actual cycle (s)" hint="Operator-entered — no connected telemetry">
          <Input id={`pp-actual-ct-${jobStageId}`} type="number" min="0" step="0.01" value={actualCycleTimeSeconds} onChange={(e) => setActualCycleTimeSeconds(e.target.value)} disabled={disabled} />
        </Field>
      </div>
      <Field id={`pp-total-cav-${jobStageId}`} label="Total cavities">
        <Input id={`pp-total-cav-${jobStageId}`} type="number" min="1" step="1" value={totalCavities} onChange={(e) => setTotalCavities(e.target.value)} disabled={disabled} />
      </Field>
      <Field id={`pp-good-cav-${jobStageId}`} label="Good cavities" error={sub.fieldErrors.goodCavities}>
        <Input id={`pp-good-cav-${jobStageId}`} type="number" min="0" step="1" value={goodCavities} onChange={(e) => setGoodCavities(e.target.value)} disabled={disabled} />
      </Field>
      {!disabled ? (
        <div className="sm:col-span-3">
          <SubmitButton pending={sub.pending} pendingLabel="Saving…">Save</SubmitButton>
        </div>
      ) : stageCompleted ? (
        <p className="sm:col-span-3 text-xs text-muted-foreground">This stage is completed — its process detail can no longer be changed.</p>
      ) : null}
    </form>
  );
}
