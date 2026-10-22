"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ListOrdered, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { FormError } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";

interface Row {
  key: number;
  name: string;
  workCentre: string;
  plannedStart: string;
  plannedEnd: string;
  operatorUserId: string;
  requiresInspection: boolean;
}
const blank = (key: number): Row => ({ key, name: "", workCentre: "", plannedStart: "", plannedEnd: "", operatorUserId: "", requiresInspection: false });

// Defines (or replaces) the job's routing. Only offered before any stage has
// started; the server refuses it afterwards regardless of this button.
export function DefineStagesDialog({
  jobId,
  initial,
  operators,
}: {
  jobId: string;
  initial: { name: string; workCentre: string | null; plannedStart: string | null; plannedEnd: string | null; operatorUserId: string | null; requiresInspection: boolean }[];
  operators: { id: string; name: string }[] | null;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>(
    initial.length
      ? initial.map((s, i) => ({ key: i, name: s.name, workCentre: s.workCentre ?? "", plannedStart: s.plannedStart?.slice(0, 10) ?? "", plannedEnd: s.plannedEnd?.slice(0, 10) ?? "", operatorUserId: s.operatorUserId ?? "", requiresInspection: s.requiresInspection }))
      : [blank(0)],
  );
  const [nextKey, setNextKey] = useState(Math.max(initial.length, 1));
  const [problems, setProblems] = useState<Record<number, string>>({});
  const patch = (key: number, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  function close() {
    if (sub.pending) return;
    setOpen(false);
    sub.clear();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const errs: Record<number, string> = {};
    const seen = new Set<string>();
    for (const r of rows) {
      const n = r.name.trim().toLowerCase();
      if (!n) errs[r.key] = "Give the stage a name.";
      else if (seen.has(n)) errs[r.key] = "Stage names must be different.";
      else if (r.plannedStart && r.plannedEnd && r.plannedEnd < r.plannedStart) errs[r.key] = "Planned end is before planned start.";
      seen.add(n);
    }
    setProblems(errs);
    if (Object.keys(errs).length) return sub.fail("Fix the highlighted stages and try again.");
    const body = {
      stages: rows.map((r) => ({
        name: r.name.trim(),
        requiresInspection: r.requiresInspection,
        ...(r.workCentre.trim() ? { workCentre: r.workCentre.trim() } : {}),
        ...(r.plannedStart ? { plannedStart: r.plannedStart } : {}),
        ...(r.plannedEnd ? { plannedEnd: r.plannedEnd } : {}),
        ...(r.operatorUserId ? { operatorUserId: r.operatorUserId } : {}),
      })),
    };
    const res = await sub.run(() => apiRequest(`/api/v1/production-jobs/${jobId}/stages`, { method: "PUT", body }));
    if (res?.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <ListOrdered /> {initial.length ? "Edit stages" : "Define stages"}
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        size="lg"
        title="Production stages"
        description="Stages run in this order. Each must be started in sequence and completed with recorded output; the job can't be completed until all are done."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close} disabled={sub.pending}>
              Cancel
            </Button>
            <Button type="submit" form="define-stages-form" disabled={sub.pending} aria-busy={sub.pending}>
              {sub.pending ? "Saving…" : "Save stages"}
            </Button>
          </>
        }
      >
        <form id="define-stages-form" onSubmit={onSubmit} noValidate className="space-y-3">
          <FormError message={sub.error} />
          <ol className="space-y-3">
            {rows.map((r, i) => (
              <li key={r.key} className="rounded-lg border border-border p-3">
                <div className="grid gap-3 sm:grid-cols-[2rem_1fr_1fr_auto] sm:items-end">
                  <span className="text-sm font-medium text-muted-foreground">{i + 1}.</span>
                  <label className="space-y-1 text-xs font-medium text-muted-foreground">
                    Stage name
                    <Input value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} aria-invalid={Boolean(problems[r.key]) || undefined} />
                  </label>
                  <label className="space-y-1 text-xs font-medium text-muted-foreground">
                    Work centre
                    <Input value={r.workCentre} onChange={(e) => patch(r.key, { workCentre: e.target.value })} placeholder="optional" />
                  </label>
                  <Button type="button" variant="ghost" size="icon" aria-label={`Remove stage ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                    <Trash2 />
                  </Button>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-4 sm:items-end">
                  <label className="space-y-1 text-xs font-medium text-muted-foreground">
                    Planned start
                    <Input type="date" value={r.plannedStart} onChange={(e) => patch(r.key, { plannedStart: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-xs font-medium text-muted-foreground">
                    Planned end
                    <Input type="date" value={r.plannedEnd} onChange={(e) => patch(r.key, { plannedEnd: e.target.value })} />
                  </label>
                  {operators ? (
                    <label className="space-y-1 text-xs font-medium text-muted-foreground">
                      Responsible operator
                      <Select value={r.operatorUserId} onChange={(e) => patch(r.key, { operatorUserId: e.target.value })}>
                        <option value="">Unassigned</option>
                        {operators.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : null}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={r.requiresInspection} onChange={(e) => patch(r.key, { requiresInspection: e.target.checked })} className="size-4 accent-[var(--primary)]" />
                    Requires inspection
                  </label>
                </div>
                {problems[r.key] ? <p role="alert" className="mt-2 text-xs text-destructive">{problems[r.key]}</p> : null}
              </li>
            ))}
          </ol>
          <Button type="button" variant="outline" disabled={rows.length >= 50} onClick={() => { setRows((rs) => [...rs, blank(nextKey)]); setNextKey((k) => k + 1); }}>
            <Plus /> Add stage
          </Button>
          <Notice tone="neutral">Saving replaces the whole routing. This is only possible before any stage has started.</Notice>
        </form>
      </Modal>
    </>
  );
}
