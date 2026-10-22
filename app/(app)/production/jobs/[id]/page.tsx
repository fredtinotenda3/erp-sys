import Link from "next/link";
import { notFound } from "next/navigation";

import { getJob, listJobs } from "../../../../../src/server/modules/production/job-service";
import { getJobMaterials } from "../../../../../src/server/modules/inventory/material-issue-service";
import { getJobCost } from "../../../../../src/server/modules/costing/cost-service";
import { listBomVersions } from "../../../../../src/server/modules/catalog/bom-service";
import { listAuditLog } from "../../../../../src/server/modules/iam/audit-service";
import { acceptsWork } from "../../../../../src/server/modules/production/job-state";
import { listStages } from "../../../../../src/server/modules/production/stage-service";
import { listOutput } from "../../../../../src/server/modules/production/output-service";
import { listInspections } from "../../../../../src/server/modules/production/quality-service";
import { getJobReadiness } from "../../../../../src/server/modules/production/readiness-api";
import { DefineStagesDialog } from "../../../../../components/features/production/shopfloor/define-stages-dialog";
import { InspectionForm } from "../../../../../components/features/production/shopfloor/inspection-form";
import { OutputForm } from "../../../../../components/features/production/shopfloor/output-form";
import { InspectionsPanel, OutputHistory, ReadinessNotice, StagesPanel } from "../../../../../components/features/production/shopfloor/panels";
import { EditJobDialog } from "../../../../../components/features/production/edit-job-dialog";
import { IssueMaterialDialog } from "../../../../../components/features/production/issue-material-dialog";
import { JobActions } from "../../../../../components/features/production/job-actions";
import { LabourForm } from "../../../../../components/features/production/labour-form";
import { CostAdjustmentDialog } from "../../../../../components/features/production/cost-adjustment-dialog";
import { CostsView } from "../../../../../components/features/production/costs-view";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { LocalTime } from "../../../../../components/ui/local-time";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { Money, Provenance, Quantity } from "../../../../../components/ui/provenance";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { JobStatusBadge, OverdueBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { TabsNav, type TabItem } from "../../../../../components/ui/tabs-nav";
import { describeAudit } from "../../../../../lib/audit-describe";
import { formatDate, formatDateTimeUtc } from "../../../../../lib/format";
import { getPageContext, load, param, UUID_RE } from "../../../../../lib/server/page-context";
import { loadCurrencies, loadCustomers, loadItems, loadUsers, loadWarehouses, itemLabel, type Lookup } from "../../../../../lib/server/lookups";
import type { AuditEntry, Bom, InspectionList, Item, Job, JobCost, JobMaterialRow, OutputList, Readiness, StageView } from "../../../../../lib/api-types";
import type { PageContext } from "../../../../../lib/server/page-context";

const EDITABLE = new Set(["planned", "released", "in_progress", "on_hold"]);

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getPageContext();
  if (!ctx.can("production_job:read")) return <AccessDenied what="production jobs" />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const jobRes = await load<Job>(() => getJob(ctx.session, id));
  if (!jobRes.ok) {
    if (jobRes.status === 404) notFound();
    return <LoadFailure status={jobRes.status} message={jobRes.message} what="this job" />;
  }
  const job = jobRes.data;
  const sp = await searchParams;

  const showCost = ctx.can("cost:read");
  const showActivity = ctx.can("audit_log:read");
  const showQuality = ctx.can("quality:read");
  const visible = new Set(["overview", "materials", "production", ...(showQuality ? ["quality"] : []), ...(showCost ? ["costs"] : []), ...(showActivity ? ["activity"] : [])]);
  const requested = param(sp.tab) ?? "overview";
  const tab = visible.has(requested) ? requested : "overview";

  const [items, customers, overdue] = await Promise.all([
    loadItems(ctx),
    loadCustomers(ctx),
    EDITABLE.has(job.status) && job.plannedEnd ? load<Job[]>(() => listJobs(ctx.session, { branchId: job.branchId, overdueOnly: true, limit: 500 })) : Promise.resolve(null),
  ]);
  const isOverdue = overdue?.ok ? overdue.data.some((j) => j.id === job.id) : false;
  const product = items.byId.get(job.productItemId);
  const productName = product?.name ?? `Item ${job.productItemId.slice(0, 8)}`;

  const tabs: TabItem[] = [
    { key: "overview", label: "Overview", href: `/production/jobs/${id}` },
    { key: "materials", label: "Materials", href: `/production/jobs/${id}?tab=materials` },
    { key: "production", label: "Production", href: `/production/jobs/${id}?tab=production` },
    ...(showQuality ? [{ key: "quality", label: "Quality", href: `/production/jobs/${id}?tab=quality` }] : []),
    ...(showCost ? [{ key: "costs", label: "Costs", href: `/production/jobs/${id}?tab=costs` }] : []),
    ...(showActivity ? [{ key: "activity", label: "Activity", href: `/production/jobs/${id}?tab=activity` }] : []),
  ];

  const customersList = customers.available ? customers.list.filter((c) => c.status === "active" || c.id === job.customerId).map((c) => ({ id: c.id, name: c.name })) : null;
  const canComplete = ctx.can("production_job:complete");
  const canUpdate = ctx.can("production_job:update");

  return (
    <>
      <PageHeader
        title={
          <>
            {job.jobNumber} <JobStatusBadge status={job.status} />
            {isOverdue ? <OverdueBadge /> : null}
          </>
        }
        crumbs={[{ label: "Production", href: "/production/jobs" }, { label: job.jobNumber }]}
        meta={
          <>
            {product ? (
              <Link href={`/catalog/items/${product.id}`} className="text-primary hover:underline">
                {productName}
              </Link>
            ) : (
              <span>{productName}</span>
            )}
            <span>{ctx.branchName(job.branchId)}</span>
          </>
        }
        actions={
          <>
            <JobActions jobId={id} status={job.status} hasStarted={job.actualStart !== null} canUpdate={canUpdate} canComplete={canComplete} />
            {canUpdate && EDITABLE.has(job.status) ? (
              <EditJobDialog job={job} customers={customersList} currencies={showCost ? await loadCurrencies() : []} canSeeCost={showCost} />
            ) : null}
          </>
        }
      />
      <TabsNav tabs={tabs} active={tab} label="Job sections" />

      {tab === "materials" ? (
        <MaterialsTab ctx={ctx} job={job} items={items} />
      ) : tab === "production" ? (
        <ProductionTab ctx={ctx} job={job} />
      ) : tab === "quality" ? (
        <QualityTab ctx={ctx} job={job} />
      ) : tab === "costs" ? (
        <CostsTab ctx={ctx} job={job} items={items} sp={sp} />
      ) : tab === "activity" ? (
        <ActivityTab ctx={ctx} job={job} />
      ) : (
        <OverviewTab ctx={ctx} job={job} productName={productName} customerName={job.customerId ? customers.byId.get(job.customerId)?.name : undefined} customersAvailable={customers.available} isOverdue={isOverdue} showCost={showCost} />
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

async function OverviewTab({ ctx, job, productName, customerName, customersAvailable, isOverdue, showCost }: { ctx: PageContext; job: Job; productName: string; customerName?: string; customersAvailable: boolean; isOverdue: boolean; showCost: boolean }) {
  const boms = ctx.can("bom:read") ? await load<Bom[]>(() => listBomVersions(ctx.session, job.productItemId)) : null;
  const bom = boms?.ok ? boms.data.find((b) => b.id === job.bomId) : undefined;
  const sf = await loadShopfloorView(ctx, job);
  const stageList = sf.stages.ok ? sf.stages.data.stages : [];
  const done = stageList.filter((x) => x.status === "completed").length;
  const progress = sf.output.ok ? (
    <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 border-t border-border pt-4 text-sm">
      <Row label="Good output">
        <Quantity value={sf.output.data.totals.effectiveGood} uom={sf.output.data.uom} /> <span className="text-muted-foreground">of {sf.output.data.plannedQty} planned</span>
      </Row>
      <Row label="Scrap / rework">
        <Quantity value={sf.output.data.totals.scrap} /> / <Quantity value={sf.output.data.totals.reworkOpen} />
      </Row>
      <Row label="Stages">{stageList.length === 0 ? <span className="text-muted-foreground">None defined</span> : `${done} of ${stageList.length} completed`}</Row>
      {sf.readiness.ok && acceptsWork(job.status) ? (
        <Row label="Ready to complete">{sf.readiness.data.canComplete ? <span className="text-status-success">Yes</span> : <span className="text-status-warning">Not yet — see the Production tab</span>}</Row>
      ) : null}
    </dl>
  ) : null;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Plan</CardTitle>
          <Provenance kind="planned" />
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
            <Row label="Product">{productName}</Row>
            <Row label="Quantity">
              <Quantity value={job.plannedQty} />
            </Row>
            <Row label="Planned start">{formatDate(job.plannedStart)}</Row>
            <Row label="Planned end">{formatDate(job.plannedEnd)}</Row>
            <Row label="BOM version">{bom ? `Version ${bom.version} (snapshot taken at creation)` : <span className="text-muted-foreground">Snapshot taken at creation</span>}</Row>
            {customersAvailable ? <Row label="Customer">{job.customerId ? (customerName ?? "—") : <span className="text-muted-foreground">None</span>}</Row> : null}
            {showCost ? (
              <Row label="Quoted">
                <Money amount={job.quotedAmount ?? null} currency={job.quotedCurrency} unavailableReason="no quote entered" />
              </Row>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>What has actually happened</CardTitle>
          <Provenance kind="actual" />
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
            <Row label="Started">{job.actualStart ? formatDateTimeUtc(job.actualStart) : <span className="text-muted-foreground">Not started</span>}</Row>
            <Row label="Finished">{job.actualEnd ? formatDateTimeUtc(job.actualEnd) : <span className="text-muted-foreground">Not finished</span>}</Row>
            <Row label="Schedule">{isOverdue ? <span className="text-status-danger">Overdue — planned end {formatDate(job.plannedEnd)} has passed</span> : <span className="text-muted-foreground">{job.plannedEnd ? "Not overdue" : "No planned end set"}</span>}</Row>
            <Row label="Created">{formatDateTimeUtc(job.createdAt)}</Row>
          </dl>
          {progress}
        </CardContent>
      </Card>
    </div>
  );
}

async function MaterialsTab({ ctx, job, items }: { ctx: PageContext; job: Job; items: Lookup<Item> }) {
  const [mats, warehouses] = await Promise.all([load<JobMaterialRow[]>(() => getJobMaterials(ctx.session, job.id)), loadWarehouses(ctx)]);
  if (!mats.ok) return <LoadFailure status={mats.status} message={mats.message} what="job materials" />;
  const showCost = ctx.can("cost:read");
  const label = (id: string) => itemLabel(items.byId.get(id), id);
  const branchWarehouses = warehouses.list.filter((w) => w.branchId === job.branchId && w.isActive);
  const working = acceptsWork(job.status);
  const canIssue = ctx.can("material:issue") && ctx.can("stock:read") && working && mats.data.length > 0 && branchWarehouses.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Expected quantities are the snapshot taken when the job was created; issued quantities come from the stock ledger.</p>
        {canIssue ? (
          <IssueMaterialDialog
            jobId={job.id}
            jobNumber={job.jobNumber}
            warehouses={branchWarehouses.map((w) => ({ id: w.id, name: w.name }))}
            materials={mats.data.map((m) => ({ materialItemId: m.materialItemId, label: label(m.materialItemId), uom: m.uom, remainingQty: m.remainingQty, expectedQty: m.expectedQty, issuedQty: m.issuedQty }))}
          />
        ) : null}
      </div>
      {!working && ctx.can("material:issue") ? <Notice tone="neutral">Material can only be issued while the job is released or in progress.</Notice> : null}
      {working && ctx.can("material:issue") && ctx.can("stock:read") && branchWarehouses.length === 0 && warehouses.available ? <Notice tone="warning">This job&apos;s branch has no active warehouse to issue from.</Notice> : null}
      {mats.data.length === 0 ? (
        <Notice tone="neutral">This job has no material requirements.</Notice>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Material</TH>
                <TH className="text-right">
                  Expected <Provenance kind="planned" />
                </TH>
                <TH className="text-right">
                  Issued <Provenance kind="actual" />
                </TH>
                <TH className="text-right">
                  Remaining <Provenance kind="calculated" />
                </TH>
                {showCost ? <TH className="text-right">Standard unit cost</TH> : null}
              </tr>
            </THead>
            <TBody>
              {mats.data.map((m) => (
                <TR key={m.materialItemId}>
                  <TD>
                    <Link href={`/catalog/items/${m.materialItemId}`} className="text-primary hover:underline">
                      {label(m.materialItemId)}
                    </Link>
                  </TD>
                  <TD className="text-right">
                    <Quantity value={m.expectedQty} uom={m.uom} />
                  </TD>
                  <TD className="text-right">
                    <Quantity value={m.issuedQty} uom={m.uom} />
                    {Number(m.overIssuedQty) > 0 ? <span className="block text-xs text-status-warning">+<Quantity value={m.overIssuedQty} uom={m.uom} /> over plan</span> : null}
                  </TD>
                  <TD className="text-right">
                    <Quantity value={m.remainingQty} uom={m.uom} />
                  </TD>
                  {showCost ? (
                    <TD className="text-right">
                      <Money amount={m.standardUnitCost ?? null} currency={m.standardUnitCostCurrency} unavailableReason="unpriced" />
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

async function loadShopfloorView(ctx: PageContext, job: Job) {
  const [stages, output, readiness, users] = await Promise.all([
    load<{ stages: StageView[] }>(() => listStages(ctx.session, job.id)),
    load<OutputList>(() => listOutput(ctx.session, job.id)),
    load<Readiness>(() => getJobReadiness(ctx.session, job.id)),
    loadUsers(ctx),
  ]);
  const nameOf = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "—");
  return { stages, output, readiness, users, nameOf };
}

async function ProductionTab({ ctx, job }: { ctx: PageContext; job: Job }) {
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

async function QualityTab({ ctx, job }: { ctx: PageContext; job: Job }) {
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

async function CostsTab({ ctx, job, items, sp }: { ctx: PageContext; job: Job; items: Lookup<Item>; sp: Record<string, string | string[] | undefined> }) {
  const canConvert = ctx.can("exchange_rate:read");
  const convertTo = canConvert ? param(sp.convertTo)?.toUpperCase() : undefined;
  const rateSource = canConvert ? param(sp.rateSource) : undefined;
  const asOf = canConvert ? param(sp.asOf) : undefined;
  const canAdjust = ctx.can("cost:adjust") && (job.status === "completed" || job.status === "closed");
  const [costRes, currencies, users] = await Promise.all([
    load<JobCost>(() => getJobCost(ctx.session, job.id, { ...(convertTo ? { convertTo } : {}), ...(rateSource ? { rateSource } : {}), ...(asOf ? { asOf } : {}) })),
    canConvert || canAdjust ? loadCurrencies() : Promise.resolve([]),
    loadUsers(ctx),
  ]);
  if (!costRes.ok) return <LoadFailure status={costRes.status} message={costRes.message} what="job costs" />;
  const actorName = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "System");
  return (
    <CostsView
      cost={costRes.data}
      itemLabel={(id) => itemLabel(items.byId.get(id), id)}
      actorName={actorName}
      adjustAction={canAdjust ? <CostAdjustmentDialog jobId={job.id} jobNumber={job.jobNumber} currencies={currencies} /> : null}
      convert={canConvert ? { currencies, convertTo, rateSource, asOf } : null}
    />
  );
}

async function ActivityTab({ ctx, job }: { ctx: PageContext; job: Job }) {
  const [audit, users] = await Promise.all([
    load<AuditEntry[]>(async () => (await listAuditLog(ctx.session, { entityType: "production_job", entityId: job.id, limit: 100 })).map((e) => ({ ...e, id: e.id.toString() }))),
    loadUsers(ctx),
  ]);
  if (!audit.ok) return <LoadFailure status={audit.status} message={audit.message} what="the audit log" />;
  const actor = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "System");
  return audit.data.length === 0 ? (
    <Notice tone="neutral">No recorded changes for this job yet.</Notice>
  ) : (
    <Card>
      <ul className="divide-y divide-border">
        {audit.data.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
            <span>
              {describeAudit(e)}
              {e.reason ? <span className="text-muted-foreground"> — “{e.reason}”</span> : null}
              <span className="text-muted-foreground"> · {actor(e.actorUserId)}</span>
            </span>
            <LocalTime iso={e.createdAt} />
          </li>
        ))}
      </ul>
      <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Shows changes to the job itself. Material issues are in the stock ledger and labour is in the cost tab; they can&apos;t be filtered by job in the audit log yet.</p>
    </Card>
  );
}
