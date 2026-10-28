import Link from "next/link";
import { Download } from "lucide-react";

import { listJobCosts } from "../../../../src/server/modules/costing/cost-service";
import { JOB_STATUS_VALUES, type JobStatus } from "../../../../src/server/modules/production/job-state";
import { PrintButton } from "../../../../components/features/shared/print-button";
import { Pagination } from "../../../../components/features/shared/pagination";
import { SortableTH } from "../../../../components/features/shared/sortable-th";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money } from "../../../../components/ui/provenance";
import { Select } from "../../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { JobStatusBadge } from "../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { humanize } from "../../../../lib/format";
import type { JobCostSummary } from "../../../../lib/api-types";
import { getPageContext, load, param } from "../../../../lib/server/page-context";

export const metadata = { title: "Job costs report · Operis" };
const PAGE_SIZE = 25;
const SORTS = ["job", "status", "material", "variance"] as const;

// Display-only helper: orders rows by a number the backend already computed (never derives money).
const num = (v: string | null | undefined) => (v === null || v === undefined ? Number.NEGATIVE_INFINITY : Number(v));

export default async function JobCostsReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("cost:read") || !ctx.can("production_job:read")) return <AccessDenied what="the job costs report" />;

  const sp = await searchParams;
  const s = param(sp.status);
  const status = s && (JOB_STATUS_VALUES as readonly string[]).includes(s) ? (s as JobStatus) : undefined;
  const sortP = param(sp.sort);
  const sort = (SORTS as readonly string[]).includes(sortP ?? "") ? (sortP as (typeof SORTS)[number]) : "job";
  const dir = param(sp.dir) === "desc" ? "desc" : "asc";
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);
  const branchId = ctx.selectedBranchId ?? undefined;

  const res = await load<JobCostSummary[]>(() => listJobCosts(ctx.session, { branchId, status, limit: 500 }));
  const rows = res.ok ? [...res.data] : [];
  const first = (j: JobCostSummary) => j.lines[0];
  rows.sort((a, b) => {
    const m = dir === "asc" ? 1 : -1;
    if (sort === "status") return a.status.localeCompare(b.status) * m;
    if (sort === "material") return (num(first(a)?.actual.material) - num(first(b)?.actual.material)) * m || 0;
    if (sort === "variance") return (num(first(a)?.variance.material) - num(first(b)?.variance.material)) * m || 0;
    return a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true }) * m;
  });
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const keep = { status };
  const exportQ = new URLSearchParams();
  if (status) exportQ.set("status", status);
  if (branchId) exportQ.set("branchId", branchId);

  return (
    <>
      <PageHeader
        title="Job costs"
        crumbs={[{ label: "Reports", href: "/reports" }, { label: "Job costs" }]}
        description={`${branchId ? ctx.branchName(branchId) : "All your branches"}. Amounts are shown in the currency each cost was recorded in; nothing is converted.`}
        actions={<><PrintButton /><Link href={`/api/v1/reports/job-costs/export?${exportQ.toString()}`} className={buttonVariants({ variant: "outline" })} data-print-hide><Download /> Export CSV</Link></>}
      />
      <FilterBar resetHref="/reports/job-costs">
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">All statuses</option>
            {JOB_STATUS_VALUES.map((v) => <option key={v} value={v}>{humanize(v)}</option>)}
          </Select>
        </FilterField>
      </FilterBar>
      {!res.ok ? <LoadFailure status={res.status} message={res.message} what="the job costs report" /> : rows.length === 0 ? (
        <EmptyState title={status ? "No jobs with this status" : "No jobs yet"}>Costs appear once a job has materials issued or labour recorded.</EmptyState>
      ) : (
        <>
          {rows.some((r) => !r.isMaterialEstimateComplete) ? <Notice tone="warning" className="mb-3">Some estimates are incomplete because a material has no standard cost. Those estimates are marked, and no variance is shown for them.</Notice> : null}
          <Card>
            <Table>
              <THead>
                <tr>
                  <SortableTH label="Job" sortKey="job" basePath="/reports/job-costs" params={keep} sort={sort} dir={dir} />
                  <SortableTH label="Status" sortKey="status" basePath="/reports/job-costs" params={keep} sort={sort} dir={dir} />
                  <TH>Currency</TH>
                  <TH className="text-right">Estimated material</TH>
                  <SortableTH label="Actual material" sortKey="material" basePath="/reports/job-costs" params={keep} sort={sort} dir={dir} className="text-right" />
                  <SortableTH label="Variance (actual − est.)" sortKey="variance" basePath="/reports/job-costs" params={keep} sort={sort} dir={dir} className="text-right" />
                  <TH className="text-right">Actual labour</TH>
                  <TH>Basis</TH>
                </tr>
              </THead>
              <TBody>
                {slice.flatMap((j) =>
                  (j.lines.length ? j.lines : [null]).map((l, i) => (
                    <TR key={`${j.jobId}-${l?.currency ?? "none"}`}>
                      <TD>{i === 0 ? <Link href={`/production/jobs/${j.jobId}`} className="font-medium text-primary underline-offset-2 hover:underline">{j.jobNumber}</Link> : null}</TD>
                      <TD>{i === 0 ? <JobStatusBadge status={j.status} /> : null}</TD>
                      {l ? (
                        <>
                          <TD>{l.currency}</TD>
                          <TD className="text-right"><Money amount={l.estimated.material} currency={l.currency} unavailableReason="No estimate" /></TD>
                          <TD className="text-right"><Money amount={l.actual.material} currency={l.currency} /></TD>
                          <TD className="text-right"><Money amount={l.variance.material} currency={l.currency} unavailableReason="No estimate" /></TD>
                          <TD className="text-right"><Money amount={l.actual.labour} currency={l.currency} unavailableReason="No labour recorded" /></TD>
                        </>
                      ) : <TD colSpan={5} className="text-muted-foreground">Nothing issued or recorded yet</TD>}
                      <TD className="text-xs text-muted-foreground">{i === 0 ? (j.actualBasis === "snapshot" ? "Final (frozen at completion)" : "Running total") : null}</TD>
                    </TR>
                  )),
                )}
              </TBody>
            </Table>
            <Pagination basePath="/reports/job-costs" params={{ ...keep, sort, dir }} page={page} pageSize={PAGE_SIZE} total={rows.length} />
          </Card>
          {rows.length >= 500 ? <Notice tone="info" className="mt-3">Showing the first 500 jobs. Filter by status to see others.</Notice> : null}
        </>
      )}
    </>
  );
}
