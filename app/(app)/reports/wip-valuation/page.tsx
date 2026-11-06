import Link from "next/link";

import { getWipValuation } from "../../../../src/server/modules/inventory/finished-goods-service";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money } from "../../../../components/ui/provenance";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { getPageContext, load, param, UUID_RE } from "../../../../lib/server/page-context";
import type { WipValuationForJob } from "../../../../lib/api-types";

export const metadata = { title: "WIP valuation · Operis" };

// This page is deliberately NOT a general-ledger WIP report -- see
// wip-fg-transfer.ts's file header. It shows the same operational,
// currency-grouped actual/transferred/remaining split that each job's own
// Costs tab can already show for one job, rolled up across every open job
// that still carries unreceived WIP cost.
export default async function WipValuationReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("cost:read")) return <AccessDenied what="the WIP valuation report" />;

  const sp = await searchParams;
  const requested = param(sp.jobId);
  const filterJobId = requested && UUID_RE.test(requested) ? requested : undefined;

  const res = filterJobId
    ? await load<WipValuationForJob>(() => getWipValuation(ctx.session, filterJobId))
    : await load<WipValuationForJob[]>(() => getWipValuation(ctx.session));
  const rows: WipValuationForJob[] = res.ok ? (Array.isArray(res.data) ? res.data : [res.data]) : [];

  return (
    <>
      <PageHeader
        title="WIP valuation"
        crumbs={[{ label: "Reports", href: "/reports" }, { label: "WIP valuation" }]}
        description="Work-in-progress material and labour cost not yet received into finished goods, for every open job that still carries it -- an operational inventory/WIP valuation, not a general-ledger figure. Amounts are shown in the currency each cost was recorded in; nothing is converted."
      />
      <FilterBar resetHref="/reports/wip-valuation">
        <FilterField id="jobId" label="Job ID">
          <Input id="jobId" name="jobId" defaultValue={filterJobId ?? ""} placeholder="Leave blank for all open jobs" />
        </FilterField>
      </FilterBar>
      {!res.ok ? (
        <LoadFailure status={res.status} message={res.message} what="the WIP valuation report" />
      ) : rows.length === 0 ? (
        <EmptyState title="No remaining WIP to show">{filterJobId ? "This job has no unreceived WIP cost right now." : "No open job currently has unreceived WIP cost."}</EmptyState>
      ) : (
        <div className="space-y-4">
          {rows.map((j) => (
            <Card key={j.jobId} className="p-4">
              <h2 className="mb-2 text-sm font-semibold">
                {ctx.can("production_job:read") ? (
                  <Link href={`/production/jobs/${j.jobId}?tab=costs`} className="text-primary hover:underline">
                    {j.jobNumber}
                  </Link>
                ) : (
                  j.jobNumber
                )}
              </h2>
              <Table>
                <THead>
                  <tr>
                    <TH>Currency</TH>
                    <TH className="text-right">Actual material</TH>
                    <TH className="text-right">Actual labour</TH>
                    <TH className="text-right">Transferred to FG</TH>
                    <TH className="text-right">Remaining WIP (material)</TH>
                    <TH className="text-right">Remaining WIP (labour)</TH>
                  </tr>
                </THead>
                <TBody>
                  {j.lines.map((l) => (
                    <TR key={l.currency}>
                      <TD>{l.currency}</TD>
                      <TD className="text-right">
                        <Money amount={l.actualMaterialCost} currency={l.currency} />
                      </TD>
                      <TD className="text-right">
                        <Money amount={l.actualLabourCost} currency={l.currency} unavailableReason="no labour recorded" />
                      </TD>
                      <TD className="text-right">
                        <Money amount={l.transferredMaterialCost} currency={l.currency} />
                      </TD>
                      <TD className="text-right font-medium">
                        <Money amount={l.remainingMaterialCost} currency={l.currency} />
                      </TD>
                      <TD className="text-right font-medium">
                        <Money amount={l.remainingLabourCost} currency={l.currency} unavailableReason="no labour recorded" />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          ))}
          <Notice tone="neutral">A cost adjustment posted to a completed job after some of its output was already received into finished goods is not reflected here for that job&apos;s still-outstanding output -- a documented, accepted gap (see the job&apos;s Costs tab for its full adjustment history).</Notice>
        </div>
      )}
    </>
  );
}
