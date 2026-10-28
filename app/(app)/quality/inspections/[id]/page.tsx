import Link from "next/link";

import { getInspectionById } from "../../../../../src/server/modules/production/quality-overview";
import { acceptsWork } from "../../../../../src/server/modules/production/job-state";
import { DispositionDialog } from "../../../../../components/features/production/shopfloor/disposition-dialog";
import { Badge } from "../../../../../components/ui/badge";
import { Card } from "../../../../../components/ui/card";
import { Notice } from "../../../../../components/ui/notice";
import { PageHeader } from "../../../../../components/ui/page-header";
import { Quantity } from "../../../../../components/ui/provenance";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { JobStatusBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { formatDateTimeLocal, humanize } from "../../../../../lib/format";
import { getPageContext, load } from "../../../../../lib/server/page-context";
import { loadUsers } from "../../../../../lib/server/lookups";

export const metadata = { title: "Inspection · Operis" };

interface Insp {
  id: string; jobId: string; jobNumber: string; jobStatus: string; stageName: string | null; uom: string; product: { name: string; sku: string };
  inspectedQty: string; acceptedQty: string; rejectedQty: string; outcome: "pass" | "fail"; defectCategory: string | null; notes: string | null; evidenceRef: string | null;
  inspectorUserId: string | null; inspectedAt: string; disposition: "not_needed" | "open" | "resolved"; openRejectedQty: string;
  dispositions: { id: string; kind: string; qty: string; reason: string; decidedBy: string | null; decidedAt: string }[];
}

export default async function InspectionPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPageContext();
  if (!ctx.can("quality:read") || !ctx.can("production_job:read")) return <AccessDenied what="inspections" />;
  const { id } = await params;
  const [res, users] = await Promise.all([load<Insp>(() => getInspectionById(ctx.session, id)), loadUsers(ctx)]);
  if (!res.ok) return <LoadFailure status={res.status} message={res.message} what="this inspection" />;
  const r = res.data;
  const who = (uid: string | null) => (uid ? (users.byId.get(uid)?.fullName ?? "A user") : "—");
  // The dialog is only a convenience; the server re-checks quality:approve, job state and quantities.
  const canDecide = r.disposition === "open" && ctx.can("quality:approve") && acceptsWork(r.jobStatus as never);

  return (
    <>
      <PageHeader
        title={<>Inspection of {r.jobNumber} {r.outcome === "pass" ? <Badge variant="status-success">Passed</Badge> : <Badge variant="status-danger">Failed</Badge>}</>}
        crumbs={[{ label: "Quality", href: "/quality" }, { label: "Inspections", href: "/quality/inspections" }, { label: r.jobNumber }]}
        meta={<><span>{r.product.name} ({r.product.sku})</span><span>{r.stageName ?? "Whole job"}</span><span>{formatDateTimeLocal(r.inspectedAt)} by {who(r.inspectorUserId)}</span><JobStatusBadge status={r.jobStatus} /></>}
        actions={<Link href={`/production/jobs/${r.jobId}?tab=quality`} className="text-sm text-primary hover:underline">Open job quality tab</Link>}
      />
      <Card className="mb-5 p-4">
        <dl className="grid gap-4 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Inspected</dt><dd><Quantity value={r.inspectedQty} uom={r.uom} /></dd></div>
          <div><dt className="text-xs text-muted-foreground">Accepted</dt><dd><Quantity value={r.acceptedQty} uom={r.uom} /></dd></div>
          <div><dt className="text-xs text-muted-foreground">Rejected</dt><dd><Quantity value={r.rejectedQty} uom={r.uom} /></dd></div>
          <div><dt className="text-xs text-muted-foreground">Defect category</dt><dd>{r.defectCategory ? humanize(r.defectCategory) : "—"}</dd></div>
          {r.notes ? <div className="sm:col-span-4"><dt className="text-xs text-muted-foreground">Notes</dt><dd className="whitespace-pre-line">{r.notes}</dd></div> : null}
          {r.evidenceRef ? <div className="sm:col-span-4"><dt className="text-xs text-muted-foreground">Evidence reference</dt><dd>{r.evidenceRef}</dd></div> : null}
        </dl>
      </Card>

      {r.disposition === "open" ? (
        <Notice tone="warning" className="mb-4">
          <Quantity value={r.openRejectedQty} uom={r.uom} /> of rejected output still needs a decision (scrap, rework or use as is), and the job can&apos;t be completed until it is made.
          {!ctx.can("quality:approve") ? " Your role can't make this decision; ask a manager with quality approval rights." : !acceptsWork(r.jobStatus as never) ? " The job is no longer open for work, so decisions can't be added here." : ""}
        </Notice>
      ) : null}
      {canDecide ? <div className="mb-4"><DispositionDialog jobId={r.jobId} inspectionId={r.id} openQty={r.openRejectedQty} uom={r.uom} /></div> : null}

      <Card>
        <h2 className="border-b border-border px-4 py-2 text-sm font-semibold">Decisions</h2>
        {r.dispositions.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{r.disposition === "not_needed" ? "Nothing was rejected, so no decision is needed." : "No decision recorded yet."}</p> : (
          <Table>
            <THead><tr><TH>When</TH><TH>Decision</TH><TH className="text-right">Quantity</TH><TH>Reason</TH><TH>Decided by</TH></tr></THead>
            <TBody>
              {r.dispositions.map((d) => (
                <TR key={d.id}><TD className="whitespace-nowrap text-xs">{formatDateTimeLocal(d.decidedAt)}</TD><TD>{humanize(d.kind)}</TD><TD className="text-right"><Quantity value={d.qty} uom={r.uom} /></TD><TD className="max-w-md">{d.reason}</TD><TD>{who(d.decidedBy)}</TD></TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
