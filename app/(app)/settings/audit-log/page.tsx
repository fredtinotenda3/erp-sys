import Link from "next/link";

import { listAuditLog, AUDIT_ACTION_VALUES, type AuditAction } from "../../../../src/server/modules/iam/audit-service";
import { SettingsNav } from "../../../../components/features/settings/settings-nav";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { Select } from "../../../../components/ui/select";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { formatDateTimeUtc, humanize } from "../../../../lib/format";
import { isUuid } from "../../../../lib/validate";
import { getPageContext, load, param } from "../../../../lib/server/page-context";
import { loadUsers } from "../../../../lib/server/lookups";

export const metadata = { title: "Audit log · Operis" };
const PAGE = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Entry { id: string; createdAt: string; actorUserId: string | null; branchId: string | null; entityType: string; entityId: string; action: string; beforeValue: unknown; afterValue: unknown; reason: string | null }

// Read-only by design: there is no edit or delete anywhere in this screen or in the API.
export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("audit_log:read")) return <AccessDenied what="the audit log" />;

  const sp = await searchParams;
  const actor = param(sp.actor);
  const actorUserId = actor && isUuid(actor) ? actor : undefined;
  const a = param(sp.action);
  const action = a && (AUDIT_ACTION_VALUES as readonly string[]).includes(a) ? (a as AuditAction) : undefined;
  const entityType = param(sp.type)?.trim() || undefined;
  const e = param(sp.entity)?.trim();
  const entityId = e && isUuid(e) ? e : undefined;
  const badEntity = Boolean(e && !entityId);
  const fromS = param(sp.from);
  const toS = param(sp.to);
  const from = fromS && DATE.test(fromS) ? new Date(`${fromS}T00:00:00Z`) : undefined;
  const to = toS && DATE.test(toS) ? new Date(`${toS}T23:59:59.999Z`) : undefined;
  const before = param(sp.before);
  const beforeId = before && /^\d{1,18}$/.test(before) ? BigInt(before) : undefined;

  const [res, users] = await Promise.all([
    load<Entry[]>(async () => (await listAuditLog(ctx.session, { branchId: ctx.selectedBranchId ?? undefined, actorUserId, action, entityType, entityId, from, to, beforeId, limit: PAGE + 1 })).map((r) => ({ ...r, id: r.id.toString() }))),
    loadUsers(ctx),
  ]);
  const rows = res.ok ? res.data.slice(0, PAGE) : [];
  const hasMore = res.ok && res.data.length > PAGE;
  const filtered = Boolean(actorUserId || action || entityType || entityId || from || to);
  const nextQ = new URLSearchParams();
  for (const [k, v] of Object.entries({ actor: actorUserId, action, type: entityType, entity: entityId, from: fromS && from ? fromS : undefined, to: toS && to ? toS : undefined })) if (v) nextQ.set(k, v);
  if (hasMore && rows.length) nextQ.set("before", rows[rows.length - 1]!.id);
  const actorName = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? `User ${id.slice(0, 8)}`) : "System");

  return (
    <>
      <PageHeader title="Settings" description={ctx.selectedBranchId ? `Branch events for ${ctx.branchName(ctx.selectedBranchId)}, plus organization-wide events.` : undefined} />
      <SettingsNav role={ctx.session.role} active="audit-log" />
      <FilterBar resetHref="/settings/audit-log">
        <FilterField id="from" label="From"><Input id="from" name="from" type="date" defaultValue={fromS ?? ""} /></FilterField>
        <FilterField id="to" label="To"><Input id="to" name="to" type="date" defaultValue={toS ?? ""} /></FilterField>
        {users.available ? (
          <FilterField id="actor" label="Person">
            <Select id="actor" name="actor" defaultValue={actorUserId ?? ""}><option value="">Anyone</option>{users.list.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>
          </FilterField>
        ) : null}
        <FilterField id="action" label="Event">
          <Select id="action" name="action" defaultValue={action ?? ""}><option value="">Any event</option>{AUDIT_ACTION_VALUES.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</Select>
        </FilterField>
        <FilterField id="type" label="Record type"><Input id="type" name="type" defaultValue={entityType ?? ""} placeholder="e.g. production_job" /></FilterField>
        <FilterField id="entity" label="Record id"><Input id="entity" name="entity" defaultValue={e ?? ""} placeholder="Paste a record id" aria-invalid={badEntity || undefined} /></FilterField>
      </FilterBar>
      {badEntity ? <p role="alert" className="mb-3 text-sm text-status-danger">That isn&apos;t a valid record id, so it was ignored.</p> : null}

      {!res.ok ? <LoadFailure status={res.status} message={res.message} what="the audit log" /> : rows.length === 0 ? (
        <EmptyState title={filtered ? "No events match these filters" : "No audit events yet"}>{filtered ? "Widen the dates or clear a filter." : "Changes made in the system are recorded here."}</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead><tr><TH>When (UTC)</TH><TH>Person</TH><TH>Event</TH><TH>Record</TH><TH>Details</TH></tr></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTimeUtc(r.createdAt)}</TD>
                  <TD>{actorName(r.actorUserId)}</TD>
                  <TD>{humanize(r.action)}</TD>
                  <TD><span className="font-medium">{humanize(r.entityType)}</span><span className="block font-mono text-xs text-muted-foreground">{r.entityId}</span></TD>
                  <TD className="max-w-md text-xs">
                    {r.reason ? <p className="mb-1">Reason: {r.reason}</p> : null}
                    {r.beforeValue != null || r.afterValue != null ? (
                      <details>
                        <summary className="cursor-pointer text-primary">View change</summary>
                        {r.beforeValue != null ? <><p className="mt-1 font-medium">Before</p><pre className="overflow-x-auto rounded bg-muted p-2">{JSON.stringify(r.beforeValue, null, 2)}</pre></> : null}
                        {r.afterValue != null ? <><p className="mt-1 font-medium">After</p><pre className="overflow-x-auto rounded bg-muted p-2">{JSON.stringify(r.afterValue, null, 2)}</pre></> : null}
                      </details>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
            <span>Showing {rows.length} event{rows.length === 1 ? "" : "s"}, newest first{before ? " (older page)" : ""}</span>
            {hasMore ? <Link href={`/settings/audit-log?${nextQ.toString()}`} className={buttonVariants({ variant: "outline", size: "sm" })}>Older events</Link> : null}
          </div>
        </Card>
      )}
    </>
  );
}
