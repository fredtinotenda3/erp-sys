import * as React from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { Notice } from "@/components/ui/notice";
import { Provenance, Quantity, Unavailable } from "@/components/ui/provenance";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDate, formatQuantity, formatSignedQuantity } from "@/lib/format";
import { DISPOSITION_LABELS, INSPECTION_STATE_LABELS, REJECT_REASON_LABELS } from "@/lib/labels";
import type { InspectionList, InspectionView, OutputList, Readiness, StageView } from "@/lib/api-types";
import { StageActions } from "./stage-actions";
import { VoidOutputButton } from "./void-output-button";
import { DispositionDialog } from "./disposition-dialog";

type NameOf = (id: string | null) => string;

const STAGE_BADGE: Record<StageView["status"], { variant: "status-neutral" | "status-info" | "status-success"; label: string }> = {
  pending: { variant: "status-neutral", label: "Not started" },
  in_progress: { variant: "status-info", label: "In progress" },
  completed: { variant: "status-success", label: "Completed" },
};

/** What still stops the job being completed. Server-computed; shown verbatim. */
export function ReadinessNotice({ readiness }: { readiness: Readiness }) {
  if (readiness.canComplete) {
    return readiness.usesStages ? <Notice tone="success">Every stage is complete and nothing is awaiting a quality decision: the job can be completed.</Notice> : null;
  }
  return (
    <Notice tone="warning" title="Not ready to complete">
      <ul className="list-disc pl-4">
        {readiness.jobBlockers.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </Notice>
  );
}

export function StagesPanel({
  jobId,
  stages,
  canTransition,
  jobOpen,
  nameOf,
  headerAction,
}: {
  jobId: string;
  stages: StageView[];
  canTransition: boolean;
  jobOpen: boolean;
  nameOf: NameOf;
  headerAction: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Stages</CardTitle>
        {headerAction}
      </CardHeader>
      {stages.length === 0 ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">No stages are defined for this job. Output can still be recorded against the job as a whole; define stages to track progress step by step.</p>
        </CardContent>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>#</TH>
              <TH>Stage</TH>
              <TH>
                Planned <Provenance kind="planned" />
              </TH>
              <TH>
                Actual <Provenance kind="actual" />
              </TH>
              <TH>Responsible</TH>
              <TH className="text-right">Good / scrap / rework</TH>
              <TH>Inspection</TH>
              <TH>Status</TH>
              {canTransition && jobOpen ? <TH></TH> : null}
            </tr>
          </THead>
          <TBody>
            {stages.map((s) => (
              <TR key={s.id}>
                <TD>{s.sequence}</TD>
                <TD>
                  <span className="font-medium">{s.name}</span>
                  {s.workCentre ? <span className="block text-xs text-muted-foreground">{s.workCentre}</span> : null}
                </TD>
                <TD className="whitespace-nowrap text-xs">
                  {s.plannedStart || s.plannedEnd ? `${formatDate(s.plannedStart)} → ${formatDate(s.plannedEnd)}` : <span className="text-muted-foreground">Not scheduled</span>}
                </TD>
                <TD className="whitespace-nowrap text-xs">
                  {s.startedAt ? `${formatDate(s.startedAt)} → ${s.completedAt ? formatDate(s.completedAt) : "…"}` : <span className="text-muted-foreground">Not started</span>}
                </TD>
                <TD>{s.operatorUserId ? nameOf(s.operatorUserId) : <span className="text-muted-foreground">Unassigned</span>}</TD>
                <TD className="text-right tabular-nums">
                  {formatQuantity(s.output.effectiveGood)} / {formatQuantity(s.output.scrap)} / {formatQuantity(s.output.rework)}
                  {Number(s.output.reworkOpen) > 0 ? <span className="block text-xs text-status-warning">{formatQuantity(s.output.reworkOpen)} still in rework</span> : null}
                </TD>
                <TD className="text-xs">
                  {s.requiresInspection || s.inspection.state !== "not_required" ? INSPECTION_STATE_LABELS[s.inspection.state] : <span className="text-muted-foreground">Not required</span>}
                </TD>
                <TD className="space-x-1.5 whitespace-nowrap">
                  <Badge variant={STAGE_BADGE[s.status].variant}>{STAGE_BADGE[s.status].label}</Badge>
                  {s.blockedReason ? (
                    <Badge variant="status-warning" title={s.blockedReason}>
                      Blocked
                    </Badge>
                  ) : null}
                  {s.isDelayed ? <Badge variant="status-danger">Delayed</Badge> : null}
                  {s.blockedReason ? <span className="block max-w-56 whitespace-normal text-xs text-muted-foreground">{s.blockedReason}</span> : null}
                  {s.status === "in_progress" && s.completionBlockers.length > 0 ? (
                    <span id={`blk-${s.id}`} className="block max-w-72 whitespace-normal text-xs text-muted-foreground">
                      To complete: {s.completionBlockers.join(" ")}
                    </span>
                  ) : null}
                </TD>
                {canTransition && jobOpen ? (
                  <TD>
                    <StageActions jobId={jobId} stage={s} />
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

export function OutputHistory({
  jobId,
  output,
  stageName,
  nameOf,
  canVoid,
  jobOpen,
  exceedsNote,
  staged = false,
}: {
  jobId: string;
  output: OutputList;
  stageName: (id: string | null) => string;
  nameOf: NameOf;
  canVoid: boolean;
  jobOpen: boolean;
  exceedsNote?: boolean;
  /** The job has a routing: good output means units that left the LAST stage. */
  staged?: boolean;
}) {
  const t = output.totals;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Output</CardTitle>
        <span className="text-xs text-muted-foreground">Unit: {output.uom ?? "—"}</span>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
          <div>
            <dt className="text-xs text-muted-foreground">
              Planned <Provenance kind="planned" />
            </dt>
            <dd className="font-medium tabular-nums">{formatQuantity(output.plannedQty, output.uom)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {staged ? "Finished good" : "Good so far"} <Provenance kind="actual" />
            </dt>
            <dd className="font-medium tabular-nums">{formatQuantity(t.effectiveGood, output.uom)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Scrap</dt>
            <dd className="font-medium tabular-nums">{formatQuantity(t.scrap, output.uom)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">In rework</dt>
            <dd className="font-medium tabular-nums">{formatQuantity(t.reworkOpen, output.uom)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              Yield <Provenance kind="calculated" />
            </dt>
            <dd className="font-medium tabular-nums">{t.yieldPercent ? `${t.yieldPercent}%` : <Unavailable reason={t.processed === "0" ? "nothing recorded" : "after the last stage completes"} />}</dd>
          </div>
        </dl>
        {output.exceedsPlan && exceedsNote !== false ? <p className="mt-3 text-xs text-status-warning">Good output is above the planned quantity.</p> : null}
        <p className="mt-2 text-xs text-muted-foreground">{staged ? "Finished good = units that have left the last stage; scrap and rework count wherever they happen. " : ""}Yield = good units ÷ (good + scrap + rework still open), stated once every stage is complete. Recording output posts no cost; the cost of scrap and rework is already in the issued material and labour.</p>
      </CardContent>
      {output.entries.length > 0 ? (
        <Table>
          <THead>
            <tr>
              <TH>When</TH>
              <TH>Stage</TH>
              <TH className="text-right">Good</TH>
              <TH className="text-right">Scrap</TH>
              <TH className="text-right">Rework</TH>
              <TH>Reason / notes</TH>
              <TH>By</TH>
              {canVoid && jobOpen ? <TH></TH> : null}
            </tr>
          </THead>
          <TBody>
            {output.entries.map((e) => (
              <TR key={e.id} className={e.voided ? "opacity-60" : undefined}>
                <TD>
                  <LocalTime iso={e.recordedAt} />
                </TD>
                <TD>{stageName(e.jobStageId)}</TD>
                <TD className="text-right tabular-nums">
                  <span className={e.voided ? "line-through" : undefined}>{e.reclassifiedFromGoodQty !== "0" ? formatSignedQuantity(`-${e.reclassifiedFromGoodQty}`) : formatQuantity(e.goodQty)}</span>
                </TD>
                <TD className="text-right tabular-nums"><span className={e.voided ? "line-through" : undefined}>{formatQuantity(e.scrapQty)}</span></TD>
                <TD className="text-right tabular-nums"><span className={e.voided ? "line-through" : undefined}>{formatQuantity(e.reworkQty)}</span></TD>
                <TD className="max-w-64 whitespace-normal text-xs">
                  {e.reason ? REJECT_REASON_LABELS[e.reason] : null}
                  {e.source === "quality_disposition" ? <span className="block text-muted-foreground">From a quality decision</span> : null}
                  {e.notes && e.source === "operator" ? <span className="block text-muted-foreground">{e.notes}</span> : null}
                  {e.voided ? <span className="block text-status-danger">Voided: {e.voided.reason}</span> : null}
                </TD>
                <TD>{nameOf(e.operatorUserId)}</TD>
                {canVoid && jobOpen ? (
                  <TD>
                    {!e.voided && e.source === "operator" ? (
                      <VoidOutputButton jobId={jobId} outputId={e.id} summary={`${formatQuantity(e.goodQty)} good, ${formatQuantity(e.scrapQty)} scrap, ${formatQuantity(e.reworkQty)} rework`} />
                    ) : null}
                  </TD>
                ) : null}
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <CardContent className="border-t border-border text-sm text-muted-foreground">No output has been recorded yet.</CardContent>
      )}
    </Card>
  );
}

export function InspectionsPanel({
  jobId,
  list,
  stageName,
  nameOf,
  canApprove,
  jobOpen,
  uom,
}: {
  jobId: string;
  list: InspectionList;
  stageName: (id: string | null) => string;
  nameOf: NameOf;
  canApprove: boolean;
  jobOpen: boolean;
  uom: string;
}) {
  const s = list.summary;
  const outcomeBadge = (i: InspectionView) =>
    i.outcome === "pass" ? <Badge variant="status-success">Passed</Badge> : i.disposition === "open" ? <Badge variant="status-danger">Failed — decision needed</Badge> : <Badge variant="status-warning">Failed — resolved</Badge>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Inspections</CardTitle>
        <span className="text-xs text-muted-foreground">
          {s.total} recorded · {s.passed} passed · {s.failed} failed
          {Number(s.openRejectedUnits) > 0 ? ` · ${formatQuantity(s.openRejectedUnits, uom)} awaiting a decision` : ""}
        </span>
      </CardHeader>
      {list.inspections.length === 0 ? (
        <CardContent className="text-sm text-muted-foreground">No inspections have been recorded for this job.</CardContent>
      ) : (
        <ul className="divide-y divide-border">
          {list.inspections.map((i) => (
            <li key={i.id} className="space-y-1.5 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  {outcomeBadge(i)}
                  <span className="font-medium">{stageName(i.jobStageId)}</span>
                  <span className="tabular-nums">
                    <Quantity value={i.inspectedQty} uom={uom} /> inspected · <Quantity value={i.acceptedQty} /> accepted · <Quantity value={i.rejectedQty} /> rejected
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {nameOf(i.inspectorUserId)} · <LocalTime iso={i.inspectedAt} />
                </span>
              </div>
              {i.outcome === "fail" ? (
                <p className="text-xs text-muted-foreground">
                  Defect: {i.defectCategory ? REJECT_REASON_LABELS[i.defectCategory] : "—"}
                  {i.notes ? ` — ${i.notes}` : ""}
                  {i.evidenceRef ? ` · evidence: ${i.evidenceRef}` : ""}
                </p>
              ) : null}
              {i.dispositions.length > 0 ? (
                <ul className="space-y-0.5 text-xs">
                  {i.dispositions.map((d) => (
                    <li key={d.id}>
                      <strong>{DISPOSITION_LABELS[d.kind]}</strong> {formatQuantity(d.qty, uom)} — “{d.reason}” <span className="text-muted-foreground">· {nameOf(d.decidedBy)}, <LocalTime iso={d.decidedAt} /></span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {i.disposition === "open" ? (
                <div className="flex items-center justify-between gap-2 rounded-md bg-status-danger-bg px-3 py-2 text-xs">
                  <span>
                    {formatQuantity(i.openRejectedQty, uom)} rejected unit(s) still need a decision{canApprove ? "" : " from someone with quality approval rights"}.
                  </span>
                  {canApprove && jobOpen ? <DispositionDialog jobId={jobId} inspectionId={i.id} openQty={i.openRejectedQty} uom={uom} /> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
