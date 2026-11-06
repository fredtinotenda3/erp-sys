import { getCapacityVisibility } from "@/src/server/modules/production/capacity-service";
import { FilterBar, FilterField } from "@/components/features/shared/filter-bar";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getPageContext, load, param, UUID_RE } from "@/lib/server/page-context";
import { loadWorkCentres } from "@/lib/server/lookups";
import type { CapacityReport } from "@/lib/api-types";

export const metadata = { title: "Capacity visibility · Operis" };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function CapacityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("machine:read") || !ctx.can("production_job:read")) return <AccessDenied what="capacity visibility" />;

  const sp = await searchParams;
  const workCentreId = param(sp.workCentreId);
  const from = param(sp.from);
  const to = param(sp.to);

  const [report, workCentres] = await Promise.all([
    load<CapacityReport>(() =>
      getCapacityVisibility(ctx.session, {
        branchId: ctx.selectedBranchId ?? undefined,
        workCentreId: workCentreId && UUID_RE.test(workCentreId) ? workCentreId : undefined,
        from: from && DATE.test(from) ? from : undefined,
        to: to && DATE.test(to) ? to : undefined,
      }),
    ),
    loadWorkCentres(ctx, ctx.selectedBranchId ? { branchId: ctx.selectedBranchId } : {}),
  ]);

  return (
    <>
      <PageHeader
        title="Capacity visibility"
        description="Planned stage load vs. configured daily capacity, by work centre and day. This is a date-bucketed estimate, not finite-capacity scheduling: it does not sequence work or account for machine-level contention within a work centre."
      />

      <FilterBar resetHref="/production/capacity">
        <FilterField id="workCentreId" label="Work centre">
          <Select id="workCentreId" name="workCentreId" defaultValue={workCentreId ?? ""}>
            <option value="">All work centres</option>
            {workCentres.list.map((wc) => (
              <option key={wc.id} value={wc.id}>
                {wc.name} ({wc.code})
              </option>
            ))}
          </Select>
        </FilterField>
        <FilterField id="from" label="From">
          <Input id="from" name="from" type="date" defaultValue={from ?? ""} />
        </FilterField>
        <FilterField id="to" label="To">
          <Input id="to" name="to" type="date" defaultValue={to ?? ""} />
        </FilterField>
      </FilterBar>

      {!report.ok ? (
        <LoadFailure status={report.status} message={report.message} what="the capacity report" />
      ) : report.data.workCentres.length === 0 ? (
        <EmptyState title="No work centres to show">Add a work centre, or adjust the filters above.</EmptyState>
      ) : (
        <div className="space-y-5">
          {report.data.note ? <Notice tone="info">{report.data.note}</Notice> : null}
          {report.data.workCentres.map((wc) => (
            <Card key={wc.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">
                  {wc.name} <span className="text-muted-foreground font-normal">({wc.code})</span>
                </h2>
                <span className="text-xs text-muted-foreground">
                  {wc.dailyCapacityMinutes != null ? `${wc.dailyCapacityMinutes} min/day capacity` : "Capacity not configured"}
                </span>
              </div>
              {wc.days.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No planned stage load in this window.</p>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <TH>Date</TH>
                      <TH className="text-right">Assigned (min)</TH>
                      <TH className="text-right">Capacity (min)</TH>
                      <TH className="text-right">Utilisation</TH>
                      <TH className="text-right">Stages</TH>
                      <TH>Jobs</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {wc.days.map((d) => (
                      <TR key={d.date}>
                        <TD>{d.date}</TD>
                        <TD className="text-right tabular-nums">{d.assignedMinutes}</TD>
                        <TD className="text-right tabular-nums">{d.capacityMinutes ?? <span className="text-muted-foreground">—</span>}</TD>
                        <TD className={`text-right tabular-nums ${d.overCapacity ? "font-medium text-status-danger" : ""}`}>
                          {d.utilisationPct != null ? `${d.utilisationPct}%` : <span className="text-muted-foreground">—</span>}
                        </TD>
                        <TD className="text-right tabular-nums">{d.stageCount}</TD>
                        <TD className="max-w-xs truncate text-xs text-muted-foreground">{d.jobNumbers.join(", ")}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
