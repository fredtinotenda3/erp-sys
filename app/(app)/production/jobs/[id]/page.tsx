import Link from "next/link";
import { notFound } from "next/navigation";

import { getJob, listJobs } from "../../../../../src/server/modules/production/job-service";
import { getJobMaterials } from "../../../../../src/server/modules/inventory/material-issue-service";
import { getJobLotConsumption } from "../../../../../src/server/modules/inventory/lot-service";
import { getJobFinishedGoodsSummary } from "../../../../../src/server/modules/inventory/finished-goods-service";
import { getJobCost } from "../../../../../src/server/modules/costing/cost-service";
import { listBomVersions } from "../../../../../src/server/modules/catalog/bom-service";
import { listAuditLog } from "../../../../../src/server/modules/iam/audit-service";
import { acceptsWork } from "../../../../../src/server/modules/production/job-state";
import { listStages } from "../../../../../src/server/modules/production/stage-service";
import { getPlasticsProcessDetail } from "../../../../../src/server/modules/production/plastics-process-service";
import { getPlasticsJobCostSummary } from "../../../../../src/server/modules/production/plastics-analytics-service";
import { RegrindForm } from "../../../../../components/features/inventory/regrind-form";
import { PlasticsProcessForm } from "../../../../../components/features/production/plastics-process-form";
import { PlasticsCostSummaryPanel } from "../../../../../components/features/production/plastics-cost-summary-panel";
import { loadShopfloorView, ProductionTab, QualityTab } from "../../../../../components/features/production/shopfloor/job-sections";
import { EditJobDialog } from "../../../../../components/features/production/edit-job-dialog";
import { IssueMaterialDialog } from "../../../../../components/features/production/issue-material-dialog";
import { ReturnMaterialDialog } from "../../../../../components/features/production/return-material-dialog";
import { ReceiveFinishedGoodsDialog } from "../../../../../components/features/production/receive-finished-goods-dialog";
import { JobActions } from "../../../../../components/features/production/job-actions";
import { CostAdjustmentDialog } from "../../../../../components/features/production/cost-adjustment-dialog";
import { CostsView } from "../../../../../components/features/production/costs-view";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { LocalTime } from "../../../../../components/ui/local-time";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { Money, Provenance, Quantity } from "../../../../../components/ui/provenance";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { FgBatchStatusBadge, JobStatusBadge, OverdueBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { TabsNav, type TabItem } from "../../../../../components/ui/tabs-nav";
import { describeAudit } from "../../../../../lib/audit-describe";
import { formatDate, formatDateTimeUtc } from "../../../../../lib/format";
import { getPageContext, load, param, UUID_RE } from "../../../../../lib/server/page-context";
import { loadCurrencies, loadCustomers, loadItems, loadMoulds, loadUsers, loadWarehouses, itemLabel, type Lookup } from "../../../../../lib/server/lookups";
import type { AuditEntry, Bom, Item, Job, JobCost, JobFinishedGoodsSummary, JobLotConsumptionRow, JobMaterialRow, PlasticsJobCostSummary, PlasticsProcessDetailView } from "../../../../../lib/api-types";
import type { PageContext } from "../../../../../lib/server/page-context";

const EDITABLE = new Set(["planned", "released", "in_progress", "on_hold"]);
// Mirrors finished-goods-service.ts's FG_RECEIVABLE_STATUSES exactly -- kept
// in sync by hand since it's a UI-only gate (the server is the real
// authority and re-checks this on every receive).
const FG_RECEIVABLE = new Set(["released", "in_progress", "completed"]);

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
  const showFg = ctx.can("finished_goods:read");
  // Milestone 6: visible whenever a role could plausibly care about any
  // part of it (recording process detail, recording regrind, or reading
  // cost) -- never tied to the org's current industry profile, since reads
  // here are never profile-gated (switching profiles must never hide
  // historical data; see industry-profile-service.ts).
  const showPlastics = ctx.can("plastics_process:record") || ctx.can("regrind:create") || ctx.can("cost:read");
  const visible = new Set([
    "overview",
    "materials",
    "production",
    ...(showQuality ? ["quality"] : []),
    ...(showFg ? ["finished-goods"] : []),
    ...(showCost ? ["costs"] : []),
    ...(showPlastics ? ["plastics"] : []),
    ...(showActivity ? ["activity"] : []),
  ]);
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
    ...(showFg ? [{ key: "finished-goods", label: "Finished Goods", href: `/production/jobs/${id}?tab=finished-goods` }] : []),
    ...(showCost ? [{ key: "costs", label: "Costs", href: `/production/jobs/${id}?tab=costs` }] : []),
    ...(showPlastics ? [{ key: "plastics", label: "Plastics", href: `/production/jobs/${id}?tab=plastics` }] : []),
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
      ) : tab === "finished-goods" ? (
        <FinishedGoodsTab ctx={ctx} job={job} />
      ) : tab === "costs" ? (
        <CostsTab ctx={ctx} job={job} items={items} sp={sp} />
      ) : tab === "plastics" ? (
        <PlasticsTab ctx={ctx} job={job} items={items} />
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
            <Row label="Priority"><span className="capitalize">{job.priority}</span></Row>
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
  const canSeeLots = ctx.can("lot:read");
  const [mats, warehouses, lotsRes] = await Promise.all([
    load<JobMaterialRow[]>(() => getJobMaterials(ctx.session, job.id)),
    loadWarehouses(ctx),
    canSeeLots ? load<JobLotConsumptionRow[]>(() => getJobLotConsumption(ctx.session, job.id)) : Promise.resolve(null),
  ]);
  if (!mats.ok) return <LoadFailure status={mats.status} message={mats.message} what="job materials" />;
  const showCost = ctx.can("cost:read");
  const label = (id: string) => itemLabel(items.byId.get(id), id);
  const branchWarehouses = warehouses.list.filter((w) => w.branchId === job.branchId && w.isActive);
  const working = acceptsWork(job.status);
  const canIssue = ctx.can("material:issue") && ctx.can("stock:read") && working && mats.data.length > 0 && branchWarehouses.length > 0;
  const lots = lotsRes?.ok ? lotsRes.data : [];
  const lotsByItem = new Map<string, JobLotConsumptionRow[]>();
  for (const l of lots) lotsByItem.set(l.itemId, [...(lotsByItem.get(l.itemId) ?? []), l]);

  const returnable = mats.data
    .filter((m) => Number(m.issuedQty) > 0)
    .map((m) => ({ materialItemId: m.materialItemId, label: label(m.materialItemId), uom: m.uom, outstandingQty: m.issuedQty }));
  const canReturn = ctx.can("material:issue") && ctx.can("stock:read") && returnable.length > 0 && branchWarehouses.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Expected quantities are the snapshot taken when the job was created; issued quantities come from the stock ledger.</p>
        <div className="flex gap-2">
          {canIssue ? (
            <IssueMaterialDialog
              jobId={job.id}
              jobNumber={job.jobNumber}
              warehouses={branchWarehouses.map((w) => ({ id: w.id, name: w.name }))}
              materials={mats.data.map((m) => ({ materialItemId: m.materialItemId, label: label(m.materialItemId), uom: m.uom, remainingQty: m.remainingQty, expectedQty: m.expectedQty, issuedQty: m.issuedQty }))}
              canPickLots={canSeeLots}
            />
          ) : null}
          {canReturn ? (
            <ReturnMaterialDialog
              jobId={job.id}
              jobNumber={job.jobNumber}
              materials={returnable}
              warehouses={branchWarehouses.map((w) => ({ id: w.id, name: w.name }))}
              lots={lots}
            />
          ) : null}
        </div>
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
              {mats.data.map((m) => {
                const itemLots = lotsByItem.get(m.materialItemId) ?? [];
                return (
                <TR key={m.materialItemId}>
                  <TD>
                    <Link href={`/catalog/items/${m.materialItemId}`} className="text-primary hover:underline">
                      {label(m.materialItemId)}
                    </Link>
                    {itemLots.length > 0 ? (
                      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {itemLots.map((l) => (
                          <li key={l.lotId}>
                            <Link href={`/inventory/lots/${l.lotId}`} className="hover:underline">{l.lotNumber}</Link>: <Quantity value={l.consumed} uom={m.uom} /> consumed
                            {Number(l.returned) > 0 ? <>, <Quantity value={l.returned} uom={m.uom} /> returned</> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
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
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

async function FinishedGoodsTab({ ctx, job }: { ctx: PageContext; job: Job }) {
  const canReceiveStatus = ctx.can("finished_goods:receive") && FG_RECEIVABLE.has(job.status);
  const [summary, warehouses] = await Promise.all([load<JobFinishedGoodsSummary>(() => getJobFinishedGoodsSummary(ctx.session, job.id)), loadWarehouses(ctx)]);
  if (!summary.ok) return <LoadFailure status={summary.status} message={summary.message} what="this job's finished-goods summary" />;
  const s = summary.data;
  const branchWarehouses = warehouses.list.filter((w) => w.branchId === job.branchId && w.isActive);
  const uom = s.batches[0]?.uom ?? "unit";
  const canReceiveNow = canReceiveStatus && Number(s.uncommittedGoodQty) > 0 && branchWarehouses.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Converts this job&apos;s recorded good output into valued, traceable finished-goods stock. Output can be received in parts, across more than one batch.</p>
        {canReceiveNow ? (
          <ReceiveFinishedGoodsDialog
            jobId={job.id}
            jobNumber={job.jobNumber}
            uom={uom}
            uncommittedGoodQty={s.uncommittedGoodQty}
            warehouses={branchWarehouses.map((w) => ({ id: w.id, name: w.name }))}
          />
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Produced (good)</p>
          <p className="text-lg font-semibold tabular-nums">
            <Quantity value={s.producedGoodQty} uom={uom} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Received to finished goods</p>
          <p className="text-lg font-semibold tabular-nums">
            <Quantity value={s.receivedToFinishedGoodsQty} uom={uom} />
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground">Not yet received</p>
          <p className="text-lg font-semibold tabular-nums">
            <Quantity value={s.uncommittedGoodQty} uom={uom} />
          </p>
        </Card>
      </div>

      {!canReceiveStatus && ctx.can("finished_goods:receive") ? <Notice tone="neutral">Finished goods can only be received while the job is released, in progress, or completed.</Notice> : null}
      {canReceiveStatus && branchWarehouses.length === 0 && warehouses.available ? <Notice tone="warning">This job&apos;s branch has no active warehouse to receive into.</Notice> : null}

      {s.batches.length === 0 ? (
        <Notice tone="neutral">No finished-goods batches have been received for this job yet.</Notice>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Batch</TH>
                <TH>Warehouse</TH>
                <TH>Status</TH>
                <TH className="text-right">Received</TH>
                <TH className="text-right">Remaining</TH>
                <TH>Produced</TH>
              </tr>
            </THead>
            <TBody>
              {s.batches.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <Link href={`/inventory/finished-goods/${b.id}`} className="font-medium text-primary hover:underline">
                      {b.batchNumber}
                    </Link>
                  </TD>
                  <TD>{warehouses.byId.get(b.warehouseId)?.name ?? "Warehouse"}</TD>
                  <TD>
                    <FgBatchStatusBadge status={b.status} />
                  </TD>
                  <TD className="text-right">
                    <Quantity value={b.goodQty} uom={b.uom} />
                  </TD>
                  <TD className={`text-right font-medium ${Number(b.remaining) <= 0 ? "text-muted-foreground" : ""}`}>
                    <Quantity value={b.remaining} uom={b.uom} />
                  </TD>
                  <TD>{formatDate(b.producedAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
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

async function PlasticsTab({ ctx, job, items }: { ctx: PageContext; job: Job; items: Lookup<Item> }) {
  const canRegrind = ctx.can("regrind:create") && ctx.can("stock:read");
  const canRecordProcess = ctx.can("plastics_process:record");
  const canSeeCost = ctx.can("cost:read");
  const working = acceptsWork(job.status);

  const [stagesRes, moulds, warehouses, currencies, costRes] = await Promise.all([
    load<{ stages: { id: string; name: string; status: string }[] }>(() => listStages(ctx.session, job.id)),
    loadMoulds(ctx, ctx.selectedBranchId ? { branchId: ctx.selectedBranchId } : {}),
    loadWarehouses(ctx),
    canRegrind ? loadCurrencies() : Promise.resolve([]),
    canSeeCost ? load<PlasticsJobCostSummary>(() => getPlasticsJobCostSummary(ctx.session, job.id)) : Promise.resolve(null),
  ]);

  const branchWarehouses = warehouses.list.filter((w) => w.branchId === job.branchId && w.isActive);
  const rawMaterials = items.available ? items.list.filter((i) => i.itemType === "raw_material" || i.itemType === "consumable") : [];
  const branchMoulds = moulds.available ? moulds.list.filter((m) => m.branchId === job.branchId && m.isActive) : [];

  const stages = stagesRes.ok ? stagesRes.data.stages : [];
  const processDetails = canRecordProcess || stages.length > 0
    ? await Promise.all(stages.map((s) => load<PlasticsProcessDetailView | null>(() => getPlasticsProcessDetail(ctx.session, s.id))))
    : [];

  return (
    <div className="space-y-5">
      {ctx.me.industryProfile !== "plastics" ? (
        <Notice tone="neutral" title="Not on the plastics profile">
          This organization&apos;s manufacturing profile isn&apos;t plastics, so nothing here can be added or changed right now. Existing records stay fully visible.
        </Notice>
      ) : null}

      {canSeeCost ? (
        !costRes || !costRes.ok ? (
          <Card><CardContent><p className="text-sm text-muted-foreground">Plastics cost summary isn&apos;t available right now.</p></CardContent></Card>
        ) : (
          <PlasticsCostSummaryPanel summary={costRes.data} />
        )
      ) : null}

      {stages.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Process detail by stage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {stages.map((s, i) => (
              <div key={s.id} className={i > 0 ? "border-t border-border pt-5" : ""}>
                <PlasticsProcessForm
                  jobId={job.id}
                  jobStageId={s.id}
                  stageName={s.name}
                  stageCompleted={s.status === "completed"}
                  initial={processDetails[i]?.ok ? processDetails[i]!.data : null}
                  moulds={branchMoulds.map((m) => ({ id: m.id, name: m.name, code: m.code }))}
                  canRecord={canRecordProcess}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : (
        <Notice tone="neutral">This job has no defined stages yet -- process detail is recorded per stage.</Notice>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Record regrind</CardTitle>
        </CardHeader>
        <CardContent>
          {!canRegrind ? (
            <p className="text-sm text-muted-foreground">You don&apos;t have permission to record regrind.</p>
          ) : !working ? (
            <Notice tone="neutral">Regrind can only be recorded while the job is released or in progress.</Notice>
          ) : branchWarehouses.length === 0 ? (
            <Notice tone="warning">This job&apos;s branch has no active warehouse to receive regrind into.</Notice>
          ) : rawMaterials.length === 0 ? (
            <Notice tone="warning">No raw material or consumable items are available to record regrind against.</Notice>
          ) : (
            <RegrindForm
              jobId={job.id}
              materials={rawMaterials.map((m) => ({ id: m.id, name: m.name, sku: m.sku, uom: m.uom }))}
              warehouses={branchWarehouses.map((w) => ({ id: w.id, name: w.name }))}
              currencies={currencies}
            />
          )}
        </CardContent>
      </Card>
    </div>
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
