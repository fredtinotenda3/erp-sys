import Link from "next/link";

import { WorkCentreForm } from "@/components/features/production/work-centre-form";
import { MachineForm } from "@/components/features/production/machine-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied, EmptyState, ErrorState } from "@/components/ui/states";
import { ActiveBadge, MachineStatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getPageContext } from "@/lib/server/page-context";
import { loadWorkCentres } from "@/lib/server/lookups";

export const metadata = { title: "Machines & Work Centres · Operis" };

export default async function MachinesPage() {
  const ctx = await getPageContext();
  if (!ctx.can("machine:read")) return <AccessDenied what="machines" />;

  const workCentres = await loadWorkCentres(ctx, ctx.selectedBranchId ? { branchId: ctx.selectedBranchId } : {});
  if (!workCentres.available) return <ErrorState message="The work centre list couldn't be loaded. Try again in a moment." />;

  const canManage = ctx.can("machine:manage");

  return (
    <>
      <PageHeader title="Machines & Work Centres" description="The shop-floor resource register: work centres and the machines inside them." />
      {workCentres.list.length === 0 ? (
        <EmptyState title="No work centres yet">Add a work centre before registering machines.</EmptyState>
      ) : (
        <div className="space-y-5">
          {workCentres.list.map((wc) => (
            <Card key={wc.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle>
                    {wc.name} <span className="text-muted-foreground font-normal">({wc.code})</span>
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">
                    {ctx.branchName(wc.branchId)} · {wc.dailyCapacityMinutes != null ? `${wc.dailyCapacityMinutes} min/day capacity` : "Capacity not configured"}
                  </p>
                </div>
                <ActiveBadge active={wc.isActive} />
              </CardHeader>
              <CardContent>
                {(wc.machines ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No machines registered in this work centre yet.</p>
                ) : (
                  <Table>
                    <THead>
                      <tr>
                        <TH>Machine</TH>
                        <TH>Status</TH>
                        <TH>Active</TH>
                        <TH></TH>
                      </tr>
                    </THead>
                    <TBody>
                      {(wc.machines ?? []).map((m) => (
                        <TR key={m.id}>
                          <TD className="font-medium">
                            {m.name} <span className="text-muted-foreground">({m.code})</span>
                          </TD>
                          <TD><MachineStatusBadge status={m.status} /></TD>
                          <TD><ActiveBadge active={m.isActive} /></TD>
                          <TD className="text-right">
                            <Link href={`/production/machines/${m.id}`} className="text-xs text-primary hover:underline">
                              View
                            </Link>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {canManage ? (
        <>
          <Card className="mt-5">
            <CardHeader>
              <CardTitle>Add a work centre</CardTitle>
            </CardHeader>
            <CardContent>
              <WorkCentreForm branches={ctx.me.branches} defaultBranchId={ctx.selectedBranchId} />
            </CardContent>
          </Card>

          {workCentres.list.length > 0 ? (
            <Card className="mt-5">
              <CardHeader>
                <CardTitle>Add a machine</CardTitle>
              </CardHeader>
              <CardContent>
                <MachineForm workCentres={workCentres.list.filter((wc) => wc.isActive).map((wc) => ({ id: wc.id, name: wc.name, code: wc.code }))} />
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}
