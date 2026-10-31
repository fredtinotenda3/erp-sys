import Link from "next/link";

import { listBlockedJobs, listInspectionsAcrossJobs } from "../../../src/server/modules/production/quality-overview";
import { Badge } from "../../../components/ui/badge";
import { buttonVariants } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { PageHeader } from "../../../components/ui/page-header";
import { Quantity } from "../../../components/ui/provenance";
import { AccessDenied, EmptyState, ErrorState, LoadFailure } from "../../../components/ui/states";
import { JobStatusBadge } from "../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/table";
import { formatDateTimeLocal } from "../../../lib/format";
import { getPageContext, load } from "../../../lib/server/page-context";

export const metadata = { title: "Quality · Operis" };

interface Blocked { jobs: { jobId: string; jobNumber: string; status: string; branchId: string; product: string; openRejectedUnits: string; blockers: string[] }[]; examined: number }
interface Insp { total: number; rows: { id: string; jobId: string; jobNumber: string; stageName: string | null; rejectedQty: string; openRejectedQty: string; defectCategory: string | null; inspectedAt: string; uom: string }[] }

export default async function QualityPage() {
  const ctx = await getPageContext();
  if (!ctx.can("quality:read") || !ctx.can("production_job:read")) return <AccessDenied what="quality management" />;
  const branchId = ctx.selectedBranchId ?? undefined;
  const [open, blocked] = await Promise.all([
    load<Insp>(() => listInspectionsAcrossJobs(ctx.session, { branchId, openOnly: true, limit: 10 })),
    load<Blocked>(() => listBlockedJobs(ctx.session, { branchId })),
  ]);

  return (
    <>
      <PageHeader title="Quality" description="Rejected units need a recorded decision before their job can be completed. Inspections are recorded on the job's quality tab or in the shop-floor workspace." actions={<Link href="/quality/inspections" className={buttonVariants({ variant: "outline" })}>All inspections</Link>} />

      <section className="mb-6" aria-labelledby="pending-h">
        <h2 id="pending-h" className="mb-2 text-sm font-semibold">Decisions needed {open.ok ? `(${open.data.total})` : ""}</h2>
        {!open.ok ? <LoadFailure status={open.status} message={open.message} what="pending quality decisions" /> : open.data.rows.length === 0 ? (
          <EmptyState title="No rejected units are waiting for a decision" />
        ) : (
          <Card>
            <Table>
              <THead><tr><TH>Job</TH><TH>Stage</TH><TH>Defect</TH><TH className="text-right">Rejected</TH><TH className="text-right">Awaiting decision</TH><TH>Inspected</TH><TH><span className="sr-only">Open</span></TH></tr></THead>
              <TBody>
                {open.data.rows.map((r) => (
                  <TR key={r.id}>
                    <TD><Link href={`/production/jobs/${r.jobId}?tab=quality`} className="font-medium text-primary hover:underline">{r.jobNumber}</Link></TD>
                    <TD>{r.stageName ?? "Whole job"}</TD>
                    <TD>{r.defectCategory ?? "—"}</TD>
                    <TD className="text-right"><Quantity value={r.rejectedQty} uom={r.uom} /></TD>
                    <TD className="text-right"><Quantity value={r.openRejectedQty} uom={r.uom} /></TD>
                    <TD className="text-xs">{formatDateTimeLocal(r.inspectedAt)}</TD>
                    <TD><Link href={`/quality/inspections/${r.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Review</Link></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {open.data.total > open.data.rows.length ? <p className="border-t border-border px-4 py-2 text-xs"><Link href="/quality/inspections?open=1" className="text-primary hover:underline">View all {open.data.total}</Link></p> : null}
          </Card>
        )}
      </section>

      <section aria-labelledby="blocked-h">
        <h2 id="blocked-h" className="mb-2 text-sm font-semibold">Jobs that can&apos;t be completed yet {blocked.ok ? `(${blocked.data.jobs.length})` : ""}</h2>
        {!blocked.ok ? <ErrorState message={blocked.message} /> : blocked.data.jobs.length === 0 ? (
          <EmptyState title="No open job is held up by quality or stage requirements" />
        ) : (
          <div className="space-y-3">
            {blocked.data.jobs.map((j) => (
              <Card key={j.jobId} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/production/jobs/${j.jobId}?tab=quality`} className="font-medium text-primary hover:underline">{j.jobNumber}</Link>
                  <span className="text-sm text-muted-foreground">{j.product}</span>
                  <JobStatusBadge status={j.status} />
                  {Number(j.openRejectedUnits) > 0 ? <Badge variant="status-danger">{j.openRejectedUnits} rejected units undecided</Badge> : null}
                </div>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">{j.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </Card>
            ))}
            {blocked.data.examined >= 200 ? <p className="text-xs text-muted-foreground">Checked the 200 most recently updated open jobs.</p> : null}
          </div>
        )}
      </section>
    </>
  );
}
