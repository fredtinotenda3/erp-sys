import Link from "next/link";

import { listInspectionsAcrossJobs } from "../../../../src/server/modules/production/quality-overview";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { Pagination } from "../../../../components/features/shared/pagination";
import { Badge } from "../../../../components/ui/badge";
import { Card } from "../../../../components/ui/card";
import { PageHeader } from "../../../../components/ui/page-header";
import { Quantity } from "../../../../components/ui/provenance";
import { Select } from "../../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { formatDateTimeLocal } from "../../../../lib/format";
import { getPageContext, load, param } from "../../../../lib/server/page-context";

export const metadata = { title: "Inspections · Operis" };
const PAGE_SIZE = 25;

interface Insp { total: number; rows: { id: string; jobId: string; jobNumber: string; stageName: string | null; inspectedQty: string; rejectedQty: string; openRejectedQty: string; outcome: "pass" | "fail"; disposition: string; defectCategory: string | null; inspectedAt: string; uom: string }[] }

export default async function InspectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("quality:read") || !ctx.can("production_job:read")) return <AccessDenied what="inspections" />;
  const sp = await searchParams;
  const o = param(sp.outcome);
  const outcome = o === "pass" || o === "fail" ? o : undefined;
  const openOnly = param(sp.open) === "1";
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);
  const res = await load<Insp>(() => listInspectionsAcrossJobs(ctx.session, { branchId: ctx.selectedBranchId ?? undefined, outcome, openOnly, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }));
  const filtered = Boolean(outcome || openOnly);

  return (
    <>
      <PageHeader title="Inspections" crumbs={[{ label: "Quality", href: "/quality" }, { label: "Inspections" }]} description="History of every recorded inspection, newest first. Results can't be edited; a wrong entry is corrected by the process on the job." />
      <FilterBar resetHref="/quality/inspections">
        <FilterField id="outcome" label="Result"><Select id="outcome" name="outcome" defaultValue={outcome ?? ""}><option value="">All</option><option value="pass">Passed</option><option value="fail">Failed (had rejects)</option></Select></FilterField>
        <FilterField id="open" label="Decision"><Select id="open" name="open" defaultValue={openOnly ? "1" : ""}><option value="">Any</option><option value="1">Awaiting decision</option></Select></FilterField>
      </FilterBar>
      {!res.ok ? <LoadFailure status={res.status} message={res.message} what="inspections" /> : res.data.total === 0 ? (
        <EmptyState title={filtered ? "No inspections match these filters" : "No inspections recorded yet"} />
      ) : (
        <Card>
          <Table>
            <THead><tr><TH>When</TH><TH>Job</TH><TH>Stage</TH><TH className="text-right">Inspected</TH><TH className="text-right">Rejected</TH><TH>Result</TH><TH>Decision</TH></tr></THead>
            <TBody>
              {res.data.rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-xs"><Link href={`/quality/inspections/${r.id}`} className="text-primary hover:underline">{formatDateTimeLocal(r.inspectedAt)}</Link></TD>
                  <TD><Link href={`/production/jobs/${r.jobId}?tab=quality`} className="font-medium text-primary hover:underline">{r.jobNumber}</Link></TD>
                  <TD>{r.stageName ?? "Whole job"}</TD>
                  <TD className="text-right"><Quantity value={r.inspectedQty} uom={r.uom} /></TD>
                  <TD className="text-right"><Quantity value={r.rejectedQty} uom={r.uom} /></TD>
                  <TD>{r.outcome === "pass" ? <Badge variant="status-success">Passed</Badge> : <Badge variant="status-danger">Failed</Badge>}</TD>
                  <TD>{r.disposition === "open" ? <Badge variant="status-warning">{r.openRejectedQty} awaiting decision</Badge> : r.disposition === "resolved" ? "Decided" : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination basePath="/quality/inspections" params={{ outcome, open: openOnly ? "1" : undefined }} page={page} pageSize={PAGE_SIZE} total={res.data.total} />
        </Card>
      )}
    </>
  );
}
