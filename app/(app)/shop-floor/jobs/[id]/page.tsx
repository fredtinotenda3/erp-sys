import { notFound } from "next/navigation";

import { getJob } from "../../../../../src/server/modules/production/job-service";
import { getJobMaterials } from "../../../../../src/server/modules/inventory/material-issue-service";
import { acceptsWork } from "../../../../../src/server/modules/production/job-state";
import { ProductionTab, QualityTab } from "../../../../../components/features/production/shopfloor/job-sections";
import { Card, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { Quantity } from "../../../../../components/ui/provenance";
import { AccessDenied, ErrorState, LoadFailure } from "../../../../../components/ui/states";
import { JobStatusBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { formatDate } from "../../../../../lib/format";
import { getPageContext, load, UUID_RE } from "../../../../../lib/server/page-context";
import { loadItems, itemLabel } from "../../../../../lib/server/lookups";
import type { Job, JobMaterialRow } from "../../../../../lib/api-types";

export const metadata = { title: "Shop-floor job · Operis" };

// One screen per job: what to make, what it needs, then the SAME production and quality sections
// the job page uses. Nothing here bypasses a rule; the services behind the forms decide.
export default async function ShopFloorJobPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("production_job:read")) return <AccessDenied what="the shop floor" />;
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const jobRes = await load<Job>(() => getJob(ctx.session, id));
  if (!jobRes.ok) {
    if (jobRes.status === 404) notFound();
    return <LoadFailure status={jobRes.status} message={jobRes.message} what="this job" />;
  }
  const job = jobRes.data;
  const [mats, items] = await Promise.all([load<JobMaterialRow[]>(() => getJobMaterials(ctx.session, id)), loadItems(ctx)]);
  const matRows: JobMaterialRow[] = mats.ok ? mats.data : [];
  const product = items.available ? itemLabel(items.byId.get(job.productItemId), job.productItemId) : `Item ${job.productItemId.slice(0, 8)}`;
  const working = acceptsWork(job.status);

  return (
    <>
      <PageHeader
        title={<>{job.jobNumber} <JobStatusBadge status={job.status} /></>}
        crumbs={[{ label: "Shop floor", href: "/shop-floor" }, { label: job.jobNumber }]}
        meta={<><span>{product}</span><span>Planned: <Quantity value={job.plannedQty} /></span>{job.plannedEnd ? <span>Due {formatDate(job.plannedEnd)}</span> : null}</>}
      />
      {!working ? <Notice tone="neutral" className="mb-4">This job is {job.status.replace(/_/g, " ")}, so no work can be recorded on it.</Notice> : null}

      <Card className="mb-5">
        <CardHeader><CardTitle>Materials this job needs</CardTitle></CardHeader>
        {!mats.ok ? <div className="p-4"><ErrorState title="Materials couldn't be loaded" message={mats.message} /></div> : matRows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No material requirements.</p> : (
          <Table>
            <THead><tr><TH>Material</TH><TH className="text-right">Required</TH><TH className="text-right">Issued</TH><TH className="text-right">Still to issue</TH></tr></THead>
            <TBody>
              {matRows.map((m) => (
                <TR key={m.materialItemId}><TD>{items.available ? itemLabel(items.byId.get(m.materialItemId), m.materialItemId) : `Item ${m.materialItemId.slice(0, 8)}`}</TD><TD className="text-right"><Quantity value={m.expectedQty} uom={m.uom} /></TD><TD className="text-right"><Quantity value={m.issuedQty} uom={m.uom} /></TD><TD className="text-right"><Quantity value={m.remainingQty} uom={m.uom} /></TD></TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <div className="space-y-8 [&_button]:min-h-11 [&_input]:min-h-11 [&_select]:min-h-11">
        <section aria-labelledby="prod-h"><h2 id="prod-h" className="mb-3 text-base font-semibold">Production</h2><ProductionTab ctx={ctx} job={job} /></section>
        {ctx.can("quality:read") ? <section aria-labelledby="qual-h"><h2 id="qual-h" className="mb-3 text-base font-semibold">Quality</h2><QualityTab ctx={ctx} job={job} /></section> : null}
      </div>
    </>
  );
}
