import { notFound } from "next/navigation";

import { getMould } from "../../../../../src/server/modules/production/mould-service";
import { CompleteMouldMaintenanceButton, MouldActions, MouldMachineCompatibilityForm } from "../../../../../components/features/production/mould-actions";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../../components/ui/card";
import { PageHeader } from "../../../../../components/ui/page-header";
import { AccessDenied, LoadFailure } from "../../../../../components/ui/states";
import { ActiveBadge, MouldStatusBadge } from "../../../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../../../components/ui/table";
import { getPageContext, load, UUID_RE } from "../../../../../lib/server/page-context";
import { loadItems, loadMachines } from "../../../../../lib/server/lookups";
import type { MouldDetail } from "../../../../../lib/api-types";

export const metadata = { title: "Mould · Operis" };

function fmt(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

export default async function MouldDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getPageContext();
  if (!ctx.can("mould:read")) return <AccessDenied what="moulds" />;
  if (!UUID_RE.test(id)) notFound();

  const [result, machines, items] = await Promise.all([
    load<MouldDetail>(() => getMould(ctx.session, id)),
    loadMachines(ctx),
    loadItems(ctx),
  ]);
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <LoadFailure status={result.status} message={result.message} what="this mould" />;
  }
  const m = result.data;
  const canManage = ctx.can("mould:manage");
  const product = m.compatibleProductItemId ? items.byId.get(m.compatibleProductItemId) : undefined;

  return (
    <>
      <PageHeader
        title={`${m.name} (${m.code})`}
        description={`${m.cavityCount}-cavity mould${product ? ` · cut for ${product.name}` : ""} · ${ctx.branchName(m.branchId)}`}
        crumbs={[{ label: "Production", href: "/production/jobs" }, { label: "Moulds", href: "/production/moulds" }, { label: m.code }]}
        meta={
          <>
            <MouldStatusBadge status={m.status} />
            <ActiveBadge active={m.isActive} />
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <MouldActions mouldId={m.id} status={m.status} canManage={canManage} />
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Compatible machines</CardTitle>
        </CardHeader>
        <CardContent>
          <MouldMachineCompatibilityForm
            mouldId={m.id}
            compatibleMachineIds={m.compatibleMachineIds}
            machines={machines.available ? machines.list.map((x) => ({ id: x.id, name: x.name, code: x.code })) : []}
            canManage={canManage}
          />
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
                    <TD className="text-right">{!r.completedAt ? <CompleteMouldMaintenanceButton mouldId={m.id} maintenanceId={r.id} canManage={canManage} /> : null}</TD>
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
