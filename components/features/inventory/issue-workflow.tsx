"use client";

import { useState } from "react";

import { Field } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { IssueMaterialForm, type IssueMaterialOption } from "./issue-material-form";
import { apiRequest } from "@/lib/api-client";
import type { JobMaterialRow } from "@/lib/api-types";

export interface IssueJobOption {
  id: string;
  label: string;
  branchId: string;
}

type Mats = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "ok"; jobId: string; rows: IssueMaterialOption[] };

// Inventory-side entry to "issue material to a job": pick an open job, load its
// real requirements from the materials endpoint, then reuse the same form the
// job's Materials tab uses.
export function IssueWorkflow({ jobs, warehouses, itemNames }: { jobs: IssueJobOption[]; warehouses: { id: string; name: string; branchId: string }[]; itemNames: Record<string, string>}) {
  const [jobId, setJobId] = useState("");
  const [mats, setMats] = useState<Mats>({ state: "idle" });

  async function load(id: string) {
    if (!id) return setMats({ state: "idle" });
    setMats({ state: "loading" });
    const r = await apiRequest<JobMaterialRow[]>(`/api/v1/production-jobs/${id}/materials`);
    setMats(
      r.ok
        ? {
            state: "ok",
            jobId: id,
            rows: r.data.map((m) => ({ materialItemId: m.materialItemId, label: itemNames[m.materialItemId] ?? `Item ${m.materialItemId.slice(0, 8)}`, uom: m.uom, remainingQty: m.remainingQty, expectedQty: m.expectedQty, issuedQty: m.issuedQty })),
          }
        : { state: "error", message: r.error.message },
    );
  }

  const job = jobs.find((j) => j.id === jobId);
  const whs = warehouses.filter((w) => job && w.branchId === job.branchId).map((w) => ({ id: w.id, name: w.name }));

  return (
    <div className="max-w-xl space-y-4">
      <Field id="iw-job" label="Production job" required hint="Only jobs that are released or in progress can receive material.">
        <Select
          id="iw-job"
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
      {mats.state === "loading" ? <p role="status" className="text-sm text-muted-foreground">Loading the job&apos;s materials…</p> : null}
      {mats.state === "error" ? <Notice tone="danger">{mats.message}</Notice> : null}
      {mats.state === "ok" && mats.jobId === jobId ? (
        mats.rows.length === 0 ? (
          <Notice tone="neutral">This job has no material requirements.</Notice>
        ) : whs.length === 0 ? (
          <Notice tone="warning">This job&apos;s branch has no active warehouse to issue from.</Notice>
        ) : (
          <IssueMaterialForm key={jobId} jobId={jobId} materials={mats.rows} warehouses={whs} onIssued={() => void load(jobId)} />
        )
      ) : null}
    </div>
  );
}
