import Link from "next/link";
import { Plus } from "lucide-react";

import { listJobs } from "../../../../src/server/modules/production/job-service";
import { listJobCosts } from "../../../../src/server/modules/costing/cost-service";
import { JOB_STATUS_VALUES, type JobStatus } from "../../../../src/server/modules/production/job-state";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Select } from "../../../../components/ui/select";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money, Quantity } from "../../../../components/ui/provenance";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { JobStatusBadge, OverdueBadge } from "../../../../components/ui/status-badge";
import { Notice } from "../../../../components/ui/notice";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { formatDate, humanize } from "../../../../lib/format";
import { getPageContext, load, param } from "../../../../lib/server/page-context";
import { loadCustomers, loadItems } from "../../../../lib/server/lookups";
import type { Job, JobCostSummary } from "../../../../lib/api-types";

export const metadata = { title: "Production jobs · Operis" };
const LIMIT = 200;

export default async function JobsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("production_job:read")) return <AccessDenied what="production jobs" />;

  const sp = await searchParams;
  const statusParam = param(sp.status);
  const status = statusParam && (JOB_STATUS_VALUES as readonly string[]).includes(statusParam) ? (statusParam as JobStatus) : undefined;
  const overdueOnly = param(sp.overdue) === "1";
  const branchId = ctx.selectedBranchId ?? undefined;
  const showCost = ctx.can("cost:read");

  const [jobs, overdue, costs, items, customers] = await Promise.all([
    load<Job[]>(() => listJobs(ctx.session, { branchId, status, overdueOnly: overdueOnly || undefined, limit: LIMIT })),
    // Overdue is the backend's rule; we only mark rows that it returns.
    load<Job[]>(() => listJobs(ctx.session, { branchId, status, overdueOnly: true, limit: 500 })),
    showCost ? load<JobCostSummary[]>(() => listJobCosts(ctx.session, { branchId, status })) : Promise.resolve(null),
    loadItems(ctx),
    loadCustomers(ctx),
  ]);

  const overdueIds = new Set(overdue.ok ? overdue.data.map((j) => j.id) : []);
  const costByJob = new Map((costs && costs.ok ? costs.data : []).map((c) => [c.jobId, c]));
  const multiBranch = ctx.me.branches.length > 1;
  const filtered = Boolean(status || overdueOnly);

  return (
    <>
      <PageHeader
        title="Production jobs"
        description={ctx.selectedBranchId ? `Showing ${ctx.branchName(ctx.selectedBranchId)}.` : multiBranch ? "Showing all your branches." : undefined}
        actions={
          ctx.can("production_job:create") ? (
            <Link href="/production/jobs/new" className={buttonVariants()}>
              <Plus /> New job
            </Link>
          ) : null
        }
      />

      <FilterBar resetHref="/production/jobs">
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {JOB_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField id="overdue" label="Schedule">
          <Select id="overdue" name="overdue" defaultValue={overdueOnly ? "1" : ""}>
            <option value="">Any</option>
            <option value="1">Overdue only</option>
          </Select>
        </FilterField>
      </FilterBar>

      {!jobs.ok ? (
        <LoadFailure status={jobs.status} message={jobs.message} what="production jobs" />
      ) : jobs.data.length === 0 ? (
        <EmptyState
          title={filtered ? "No jobs match these filters" : "No production jobs yet"}
          action={
            !filtered && ctx.can("production_job:create") ? (
              <Link href="/production/jobs/new" className={buttonVariants()}>
                Create the first job
              </Link>
            ) : null
          }
        >
          {filtered ? "Clear the filters to see every job." : "A job turns a product's bill of materials into planned work."}
        </EmptyState>
      ) : (
        <>
          {!items.available ? <Notice tone="warning" className="mb-3">Product names couldn&apos;t be loaded, so jobs show short ids instead.</Notice> : null}
          {costs && !costs.ok ? <Notice tone="warning" className="mb-3">Cost figures couldn&apos;t be loaded: {costs.message}</Notice> : null}
          <Card>
            <Table>
              <THead>
                <tr>
                  <TH>Job</TH>
                  <TH>Product</TH>
                  {multiBranch ? <TH>Branch</TH> : null}
                  {customers.available ? <TH>Customer</TH> : null}
                  <TH className="text-right">Planned qty</TH>
                  <TH>Planned</TH>
                  <TH>Actual</TH>
                  <TH>Status</TH>
                  {showCost ? <TH>Material cost</TH> : null}
                </tr>
              </THead>
              <TBody>
                {jobs.data.map((j) => {
                  const cost = costByJob.get(j.id);
                  return (
                    <TR key={j.id}>
                      <TD>
                        <Link href={`/production/jobs/${j.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                          {j.jobNumber}
                        </Link>
                      </TD>
                      <TD>{items.byId.get(j.productItemId)?.name ?? `Item ${j.productItemId.slice(0, 8)}`}</TD>
                      {multiBranch ? <TD>{ctx.branchName(j.branchId)}</TD> : null}
                      {customers.available ? <TD>{j.customerId ? (customers.byId.get(j.customerId)?.name ?? "—") : <span className="text-muted-foreground">—</span>}</TD> : null}
                      <TD className="text-right">
                        <Quantity value={j.plannedQty} />
                      </TD>
                      <TD className="whitespace-nowrap text-xs">
                        {formatDate(j.plannedStart)} → {formatDate(j.plannedEnd)}
                      </TD>
                      <TD className="whitespace-nowrap text-xs">
                        {j.actualStart ? `${formatDate(j.actualStart)} → ${formatDate(j.actualEnd)}` : <span className="text-muted-foreground">Not started</span>}
                      </TD>
                      <TD className="space-x-1.5 whitespace-nowrap">
                        <JobStatusBadge status={j.status} />
                        {overdueIds.has(j.id) ? <OverdueBadge /> : null}
                      </TD>
                      {showCost ? (
                        <TD className="text-xs">
                          {cost && cost.lines.length > 0 ? (
                            cost.lines.map((l) => (
                              <div key={l.currency} className="whitespace-nowrap">
                                <Money amount={l.actual.material} currency={l.currency} />{" "}
                                <span className="text-muted-foreground">{cost.actualBasis === "snapshot" ? "final" : "so far"}</span>
                                {l.estimated.material !== null ? (
                                  <span className="block text-muted-foreground">
                                    est. <Money amount={l.estimated.material} currency={l.currency} />
                                  </span>
                                ) : null}
                              </div>
                            ))
                          ) : (
                            <span className="text-muted-foreground">Nothing issued yet</span>
                          )}
                        </TD>
                      ) : null}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              {jobs.data.length} job{jobs.data.length === 1 ? "" : "s"}
              {jobs.data.length >= LIMIT ? ` · showing the first ${LIMIT}; narrow the filters to see others` : ""}
            </p>
          </Card>
        </>
      )}
    </>
  );
}
