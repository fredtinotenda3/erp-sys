// The job's shop-floor sections (production: stages, output, labour; quality: inspections and
// decisions). Shared by the job detail tabs and the operator workspace, so both run the SAME
// forms against the SAME services and business rules -- there is no second production system.
import { listStages } from "@/src/server/modules/production/stage-service";
import { listOutput } from "@/src/server/modules/production/output-service";
import { listInspections } from "@/src/server/modules/production/quality-service";
import { getJobReadiness } from "@/src/server/modules/production/readiness-api";
import { acceptsWork } from "@/src/server/modules/production/job-state";
import { DefineStagesDialog } from "@/components/features/production/shopfloor/define-stages-dialog";
import { InspectionForm } from "@/components/features/production/shopfloor/inspection-form";
import { OutputForm } from "@/components/features/production/shopfloor/output-form";
import { InspectionsPanel, OutputHistory, ReadinessNotice, StagesPanel } from "@/components/features/production/shopfloor/panels";
import { LabourForm } from "@/components/features/production/labour-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { LoadFailure } from "@/components/ui/states";
import { Quantity } from "@/components/ui/provenance";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { load } from "@/lib/server/page-context";
import { loadCurrencies, loadUsers } from "@/lib/server/lookups";
import type { PageContext } from "@/lib/server/page-context";
import type { InspectionList, Job, OutputList, Readiness, StageView } from "@/lib/api-types";

export async function loadShopfloorView(ctx: PageContext, job: Job) {
  const [stages, output, readiness, users] = await Promise.all([
    load<{ stages: StageView[] }>(() => listStages(ctx.session, job.id)),
    load<OutputList>(() => listOutput(ctx.session, job.id)),
    load<Readiness>(() => getJobReadiness(ctx.session, job.id)),
    loadUsers(ctx),
  ]);
  const nameOf = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "—");
  return { stages, output, readiness, users, nameOf };
}

export async function ProductionTab({ ctx, job }: { ctx: PageContext; job: Job }) {
  const working = acceptsWork(job.status);
  const canRecordLabour = ctx.can("labour:record") && working;
  const [currencies, sf] = await Promise.all([canRecordLabour ? loadCurrencies() : Promise.resolve([]), loadShopfloorView(ctx, job)]);

  if (!sf.stages.ok) return <LoadFailure status={sf.stages.status} message={sf.stages.message} what="production stages" />;
  const stages = sf.stages.data.stages;
  const stageName = (id: string | null) => (id ? (stages.find((x) => x.id === id)?.name ?? "Stage") : "Whole job");
  const noneStarted = stages.every((x) => x.status === "pending");
  const canDefine = ctx.can("production_job:update") && (job.status === "planned" || job.status === "released") && noneStarted && (!sf.output.ok || sf.output.data.entries.length === 0);
  const recordable = stages.filter((x) => x.status === "in_progress" && !x.blockedReason).map((x) => ({ id: x.id, label: `${x.sequence}. ${x.name}` }));
  const uom = sf.output.ok ? (sf.output.data.uom ?? "") : "";

  return (
    <div className="space-y-5">
      {working && sf.readiness.ok ? <ReadinessNotice readiness={sf.readiness.data} /> : null}

      <StagesPanel
        jobId={job.id}
        stages={stages}
        canTransition={ctx.can("stage:transition")}
        jobOpen={working}
        nameOf={sf.nameOf}
        headerAction={
          canDefine ? (
            <DefineStagesDialog
              jobId={job.id}
              operators={sf.users.available ? sf.users.list.map((u) => ({ id: u.id, name: u.fullName })) : null}
              initial={stages.map((x) => ({ name: x.name, workCentre: x.workCentre, plannedStart: x.plannedStart, plannedEnd: x.plannedEnd, operatorUserId: x.operatorUserId, requiresInspection: x.requiresInspection }))}
            />
          ) : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Record output</CardTitle>
          </CardHeader>
          <CardContent>
            {!ctx.can("output:record") ? (
              <p className="text-sm text-muted-foreground">Your role can&apos;t record production output.</p>
            ) : !working ? (
              <Notice tone="neutral">Output can only be recorded while the job is released or in progress.</Notice>
            ) : stages.length > 0 && recordable.length === 0 ? (
              <Notice tone="neutral">Start a stage first: output is recorded against a stage that is in progress and not blocked.</Notice>
            ) : (
              <OutputForm jobId={job.id} uom={uom} stages={stages.length > 0 ? recordable : []} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Record labour</CardTitle>
          </CardHeader>
          <CardContent>
            {!ctx.can("labour:record") ? (
              <p className="text-sm text-muted-foreground">Your role can&apos;t record labour.</p>
            ) : !working ? (
              <Notice tone="neutral">Labour can only be recorded while the job is released or in progress.</Notice>
            ) : currencies.length === 0 ? (
              <Notice tone="danger">The currency list couldn&apos;t be loaded, so labour can&apos;t be recorded right now.</Notice>
            ) : (
              <LabourForm jobId={job.id} currencies={currencies} />
            )}
          </CardContent>
        </Card>
      </div>

      {sf.output.ok ? (
        <OutputHistory jobId={job.id} staged={stages.length > 0} output={sf.output.data} stageName={stageName} nameOf={sf.nameOf} canVoid={ctx.can("production_job:update")} jobOpen={working} />
      ) : (
        <LoadFailure status={sf.output.status} message={sf.output.message} what="production output" />
      )}
    </div>
  );
}

export async function QualityTab({ ctx, job }: { ctx: PageContext; job: Job }) {
  const working = acceptsWork(job.status);
  const [list, stagesRes, output, users] = await Promise.all([
    load<InspectionList>(() => listInspections(ctx.session, job.id)),
    load<{ stages: StageView[] }>(() => listStages(ctx.session, job.id)),
    load<OutputList>(() => listOutput(ctx.session, job.id)),
    loadUsers(ctx),
  ]);
  if (!list.ok) return <LoadFailure status={list.status} message={list.message} what="quality records" />;
  const stages = stagesRes.ok ? stagesRes.data.stages : [];
  const nameOf = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "—");
  const stageName = (id: string | null) => (id ? (stages.find((x) => x.id === id)?.name ?? "Stage") : "Whole job");
  const uom = output.ok ? (output.data.uom ?? "") : "";
  const inspectable = stages.filter((x) => x.status === "in_progress").map((x) => ({ id: x.id, label: `${x.sequence}. ${x.name}` }));
  const canInspect = ctx.can("quality:record") && working;
  return (
    <div className="space-y-5">
      {stages.some((x) => x.requiresInspection) ? (
        <Card>
          <CardHeader>
            <CardTitle>Inspection requirements</CardTitle>
          </CardHeader>
          <Table>
            <THead>
              <tr>
                <TH>Stage</TH>
                <TH>Status</TH>
                <TH className="text-right">Reported good</TH>
                <TH className="text-right">Inspected</TH>
                <TH>Inspection</TH>
              </tr>
            </THead>
            <TBody>
              {stages.filter((x) => x.requiresInspection).map((x) => (
                <TR key={x.id}>
                  <TD>{x.sequence}. {x.name}</TD>
                  <TD>{x.status === "pending" ? "Not started" : x.status === "in_progress" ? "In progress" : "Completed"}</TD>
                  <TD className="text-right"><Quantity value={x.output.grossGood} uom={uom} /></TD>
                  <TD className="text-right"><Quantity value={x.inspection.inspected} uom={uom} /></TD>
                  <TD>{x.inspection.state === "pending" ? <span className="text-status-warning">Pending</span> : x.inspection.state === "passed" ? <span className="text-status-success">Passed</span> : x.inspection.state === "not_required" ? "—" : x.inspection.state === "failed_open" ? <span className="text-status-danger">Failed — decision needed</span> : "Failed — resolved"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      <InspectionsPanel jobId={job.id} list={list.data} stageName={stageName} nameOf={nameOf} canApprove={ctx.can("quality:approve")} jobOpen={working} uom={uom} />

      <Card>
        <CardHeader>
          <CardTitle>Record an inspection</CardTitle>
        </CardHeader>
        <CardContent>
          {!ctx.can("quality:record") ? (
            <p className="text-sm text-muted-foreground">Your role can view quality records but not record inspections.</p>
          ) : !working ? (
            <Notice tone="neutral">Inspections can only be recorded while the job is released or in progress.</Notice>
          ) : stages.length > 0 && inspectable.length === 0 ? (
            <Notice tone="neutral">No stage is in progress, so there is nothing to inspect yet.</Notice>
          ) : (
            <InspectionForm jobId={job.id} uom={uom} stages={stages.length > 0 ? inspectable : []} />
          )}
          {canInspect && !ctx.can("quality:approve") ? <p className="mt-3 text-xs text-muted-foreground">Rejected units need a decision from a manager with quality approval rights.</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
