import { notFound } from "next/navigation";

import { getMachine } from "@/src/server/modules/production/machine-service";
import { CompleteMaintenanceButton, MachineActions } from "@/components/features/production/machine-actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied, LoadFailure } from "@/components/ui/states";
import { ActiveBadge, MachineStatusBadge } from "@/components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getPageContext, load } from "@/lib/server/page-context";
import type { MachineDetail } from "@/lib/api-types";

export const metadata = { title: "Machine · Operis" };

function fmt(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export default async function MachineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getPageContext();
  if (!ctx.can("machine:read")) return <AccessDenied what="machines" />;

  const result = await load<MachineDetail>(() => getMachine(ctx.session, id));
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <LoadFailure status={result.status} message={result.message} what="this machine" />;
  }
  const m = result.data;
  const canManage = ctx.can("machine:manage");

  return (
    <>
      <PageHeader
        title={`${m.name} (${m.code})`}
        description={`In ${m.workCentre?.name ?? "an unknown work centre"} · ${ctx.branchName(m.workCentre?.branchId)}`}
        crumbs={[{ label: "Production", href: "/production/jobs" }, { label: "Machines", href: "/production/machines" }, { label: m.code }]}
        meta={
          <>
            <MachineStatusBadge status={m.status} />
            <ActiveBadge active={m.isActive} />
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <MachineActions machineId={m.id} status={m.status} openDowntimeId={m.openDowntime?.id ?? null} canManage={canManage} />
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Downtime history</CardTitle>
        </CardHeader>
        <CardContent>
          {m.recentDowntime.length === 0 ? (
            <p className="text-sm text-muted-foreground">No downtime recorded.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Category</TH>
                  <TH>Reason</TH>
                  <TH>Started</TH>
                  <TH>Ended</TH>
                </tr>
              </THead>
              <TBody>
                {m.recentDowntime.map((r) => (
                  <TR key={r.id}>
                    <TD className="capitalize">{r.category.replace(/_/g, " ")}</TD>
                    <TD>{r.reason}</TD>
                    <TD>{fmt(r.startedAt)}</TD>
                    <TD>{r.endedAt ? fmt(r.endedAt) : <span className="text-status-warning">Open</span>}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Maintenance history</CardTitle>
        </CardHeader>
        <CardContent>
          {m.maintenance.length === 0 ? (
            <p className="text-sm text-muted-foreground">No maintenance recorded.</p>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Type</TH>
                  <TH>Scheduled</TH>
                  <TH>Completed</TH>
                  <TH>Notes</TH>
                  <TH></TH>
                </tr>
              </THead>
              <TBody>
                {m.maintenance.map((r) => (
                  <TR key={r.id}>
                    <TD className="capitalize">{r.type}</TD>
                    <TD>{fmt(r.scheduledAt)}</TD>
                    <TD>{r.completedAt ? fmt(r.completedAt) : <span className="text-status-warning">Pending</span>}</TD>
                    <TD className="max-w-xs truncate text-muted-foreground">{r.notes ?? "—"}</TD>
                    <TD className="text-right">{!r.completedAt ? <CompleteMaintenanceButton machineId={m.id} maintenanceId={r.id} canManage={canManage} /> : null}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
