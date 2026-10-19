import Link from "next/link";

import { listJobs } from "../../../src/server/modules/production/job-service";
import { getShortages } from "../../../src/server/modules/inventory/shortage-service";
import { listAuditLog } from "../../../src/server/modules/iam/audit-service";
import { listStockMovements } from "../../../src/server/modules/inventory/stock-service";
import type { JobStatus } from "../../../src/server/modules/production/job-state";
import { MetricTile } from "../../../components/features/dashboard/metric-tile";
import { PageHeader } from "../../../components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Notice } from "../../../components/ui/notice";
import { EmptyState, LoadFailure } from "../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/table";
import { JobStatusBadge, OverdueBadge } from "../../../components/ui/status-badge";
import { Quantity } from "../../../components/ui/provenance";
import { LocalTime } from "../../../components/ui/local-time";
import { describeAudit } from "../../../lib/audit-describe";
import { formatDate, humanize, formatSignedQuantity, shortId } from "../../../lib/format";
import { getPageContext, load, type Loaded } from "../../../lib/server/page-context";
import { loadItems, loadUsers, itemLabel } from "../../../lib/server/lookups";
import type { AuditEntry, Job, Shortage, StockMovement } from "../../../lib/api-types";

export const metadata = { title: "Command Centre · Operis" };

const LIMIT = 500;
const denied = <T,>(what: string): Loaded<T> => ({ ok: false, status: 403, message: `Your role can't view ${what}.` });

function countText(n: number): string {
  return n >= LIMIT ? `${LIMIT}+` : String(n);
}

// Command Centre. Every figure here is read from an existing service call; a
// panel the caller can't access, or that fails to load, says so instead of
// showing a number. Orders, stages and quality don't exist yet and are listed
// as unavailable at the bottom rather than faked.
export default async function DashboardPage() {
  const ctx = await getPageContext();
  const branchId = ctx.selectedBranchId ?? undefined;
  const canJobs = ctx.can("production_job:read");
  const canStock = canJobs && ctx.can("stock:read");

  const jobsBy = (status: JobStatus) =>
    canJobs ? load<Job[]>(() => listJobs(ctx.session, { branchId, status, limit: LIMIT })) : Promise.resolve(denied<Job[]>("production jobs"));

  const [inProgress, released, planned, onHold, overdue, shortages, items, users, audit, movements] = await Promise.all([
    jobsBy("in_progress"),
    jobsBy("released"),
    jobsBy("planned"),
    jobsBy("on_hold"),
    // "Overdue" is defined by the backend (planned end before today, job still open) -- not recomputed here.
    canJobs ? load<Job[]>(() => listJobs(ctx.session, { branchId, overdueOnly: true, limit: LIMIT })) : Promise.resolve(denied<Job[]>("production jobs")),
    canStock ? load<Shortage[]>(() => getShortages(ctx.session, { branchId })) : Promise.resolve(denied<Shortage[]>("stock")),
    loadItems(ctx),
    loadUsers(ctx),
    ctx.can("audit_log:read")
      ? load<AuditEntry[]>(async () => (await listAuditLog(ctx.session, { branchId, limit: 12 })).map((e) => ({ ...e, id: e.id.toString() })))
      : Promise.resolve(denied<AuditEntry[]>("the audit log")),
    canStock ? load<StockMovement[]>(() => listStockMovements(ctx.session, { limit: 8 })) : Promise.resolve(denied<StockMovement[]>("stock movements")),
  ]);

  const productName = (id: string) => items.byId.get(id)?.name ?? (items.available ? `Item ${shortId(id)}` : "—");
  const actorName = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "System");

  // ---- derived views (presentation only: grouping/sorting of rows the API returned) ----
  const activeCount = inProgress.ok && released.ok ? inProgress.data.length + released.data.length : null;
  const overdueIds = new Set(overdue.ok ? overdue.data.map((j) => j.id) : []);

  const attention = new Map<string, { job: Job; reasons: string[] }>();
  if (overdue.ok) for (const job of overdue.data) attention.set(job.id, { job, reasons: [`Overdue — planned end ${formatDate(job.plannedEnd)}`] });
  if (onHold.ok) {
    for (const job of onHold.data) {
      const e = attention.get(job.id);
      if (e) e.reasons.push("On hold");
      else attention.set(job.id, { job, reasons: ["On hold"] });
    }
  }
  const attentionRows = [...attention.values()].slice(0, 10);

  const shortageRows = shortages.ok ? shortages.data.filter((s) => s.status === "shortage") : [];
  const lowRows = shortages.ok ? shortages.data.filter((s) => s.status === "low") : [];

  const activeRows = inProgress.ok && released.ok ? [...inProgress.data, ...released.data].slice(0, 8) : [];

  const scope = ctx.selectedBranchId ? ctx.branchName(ctx.selectedBranchId) : ctx.me.branches.length > 1 ? "all your branches" : ctx.branchName(ctx.me.branches[0]?.id);

  return (
    <>
      <PageHeader title="Command Centre" description={`What is running, what needs attention, and what is short — ${scope}.`} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {activeCount !== null && inProgress.ok && released.ok ? (
          <MetricTile
            label="Active jobs"
            value={countText(activeCount)}
            detail={`${countText(inProgress.data.length)} in progress · ${countText(released.data.length)} released${planned.ok ? ` · ${countText(planned.data.length)} planned` : ""}`}
            href="/production/jobs?status=in_progress"
          />
        ) : (
          <MetricTile label="Active jobs" unavailableReason={!inProgress.ok ? inProgress.message : !released.ok ? released.message : undefined} />
        )}
        {overdue.ok ? (
          <MetricTile label="Overdue jobs" value={countText(overdue.data.length)} detail="Planned end passed, not completed" href="/production/jobs?overdue=1" tone={overdue.data.length > 0 ? "danger" : "default"} />
        ) : (
          <MetricTile label="Overdue jobs" unavailableReason={overdue.message} />
        )}
        {onHold.ok ? (
          <MetricTile label="Jobs on hold" value={countText(onHold.data.length)} detail="Each hold has a recorded reason" href="/production/jobs?status=on_hold" tone={onHold.data.length > 0 ? "warning" : "default"} />
        ) : (
          <MetricTile label="Jobs on hold" unavailableReason={onHold.message} />
        )}
        {shortages.ok ? (
          <MetricTile
            label="Material shortages"
            value={shortageRows.length}
            detail={lowRows.length > 0 ? `${lowRows.length} more below reorder level` : "Open jobs need more than is on hand"}
            href="/inventory/stock"
            tone={shortageRows.length > 0 ? "danger" : "default"}
          />
        ) : (
          <MetricTile label="Material shortages" unavailableReason={shortages.message} />
        )}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Jobs requiring attention</CardTitle>
            <span className="text-xs text-muted-foreground">Overdue or on hold</span>
          </CardHeader>
          {!overdue.ok && !onHold.ok ? (
            <CardContent>
              <LoadFailure status={overdue.status} message={overdue.message} what="production jobs" />
            </CardContent>
          ) : attentionRows.length === 0 ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">No overdue or held jobs{overdue.ok && onHold.ok ? "" : " among the data that could be loaded"}.</p>
            </CardContent>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Job</TH>
                  <TH>Product</TH>
                  <TH>Status</TH>
                  <TH>Why</TH>
                </tr>
              </THead>
              <TBody>
                {attentionRows.map(({ job, reasons }) => (
                  <TR key={job.id}>
                    <TD>
                      <Link href={`/production/jobs/${job.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                        {job.jobNumber}
                      </Link>
                    </TD>
                    <TD>{productName(job.productItemId)}</TD>
                    <TD>
                      <JobStatusBadge status={job.status} />
                    </TD>
                    <TD className="text-muted-foreground">{reasons.join(" · ")}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {(!overdue.ok || !onHold.ok) && attentionRows.length > 0 ? (
            <CardContent className="border-t border-border">
              <Notice tone="warning">Part of this list couldn&apos;t be loaded, so it may be incomplete.</Notice>
            </CardContent>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Material shortages</CardTitle>
            <Link href="/inventory/stock" className="text-xs text-primary hover:underline">
              Open stock
            </Link>
          </CardHeader>
          {!shortages.ok ? (
            <CardContent>
              <LoadFailure status={shortages.status} message={shortages.message} what="stock levels" />
            </CardContent>
          ) : shortageRows.length === 0 ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">No open job is waiting on material that isn&apos;t in stock.</p>
            </CardContent>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Material</TH>
                  <TH className="text-right">On hand</TH>
                  <TH className="text-right">Still needed</TH>
                  <TH className="text-right">Short by</TH>
                  <TH>Jobs</TH>
                </tr>
              </THead>
              <TBody>
                {shortageRows.slice(0, 8).map((s) => (
                  <TR key={`${s.branchId}-${s.item.id}`}>
                    <TD>
                      <span className="font-medium">{s.item.name ?? itemLabel(items.byId.get(s.item.id), s.item.id)}</span>
                      {!s.hasStockRecord ? <span className="ml-1.5 text-xs text-muted-foreground">No stock recorded</span> : null}
                      {ctx.me.branches.length > 1 && !ctx.selectedBranchId ? <span className="block text-xs text-muted-foreground">{ctx.branchName(s.branchId)}</span> : null}
                    </TD>
                    <TD className="text-right">
                      <Quantity value={s.onHand} uom={s.item.uom} />
                    </TD>
                    <TD className="text-right">
                      <Quantity value={s.remainingRequirement} uom={s.item.uom} />
                    </TD>
                    <TD className="text-right font-medium text-status-danger">
                      <Quantity value={s.shortageQty} uom={s.item.uom} />
                    </TD>
                    <TD>
                      {s.demand.slice(0, 3).map((d, i) => (
                        <span key={d.jobId}>
                          {i > 0 ? ", " : ""}
                          <Link href={`/production/jobs/${d.jobId}?tab=materials`} className="text-primary hover:underline">
                            {d.jobNumber}
                          </Link>
                        </span>
                      ))}
                      {s.demand.length > 3 ? <span className="text-muted-foreground"> +{s.demand.length - 3}</span> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Active production</CardTitle>
          <Link href="/production/jobs" className="text-xs text-primary hover:underline">
            All jobs
          </Link>
        </CardHeader>
        {!inProgress.ok || !released.ok ? (
          <CardContent>
            <LoadFailure status={!inProgress.ok ? inProgress.status : 403} message={!inProgress.ok ? inProgress.message : "Couldn't load released jobs."} what="production jobs" />
          </CardContent>
        ) : activeRows.length === 0 ? (
          <CardContent>
            <EmptyState title="Nothing in production right now">Jobs appear here once they are released or in progress.</EmptyState>
          </CardContent>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Job</TH>
                <TH>Product</TH>
                <TH className="text-right">Planned qty</TH>
                <TH>Planned end</TH>
                <TH>Started</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {activeRows.map((job) => (
                <TR key={job.id}>
                  <TD>
                    <Link href={`/production/jobs/${job.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                      {job.jobNumber}
                    </Link>
                  </TD>
                  <TD>{productName(job.productItemId)}</TD>
                  <TD className="text-right">
                    <Quantity value={job.plannedQty} />
                  </TD>
                  <TD>{formatDate(job.plannedEnd)}</TD>
                  <TD>{formatDate(job.actualStart)}</TD>
                  <TD className="space-x-1.5">
                    <JobStatusBadge status={job.status} />
                    {overdueIds.has(job.id) ? <OverdueBadge /> : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <span className="text-xs text-muted-foreground">{audit.ok ? "Audit log" : movements.ok ? "Stock ledger" : ""}</span>
        </CardHeader>
        {audit.ok ? (
          audit.data.length === 0 ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">No recorded activity yet.</p>
            </CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {audit.data.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                  <span>
                    {e.entityType === "production_job" ? (
                      <Link href={`/production/jobs/${e.entityId}?tab=activity`} className="text-primary hover:underline">
                        {describeAudit(e)}
                      </Link>
                    ) : (
                      describeAudit(e)
                    )}
                    {e.reason ? <span className="text-muted-foreground"> — {e.reason}</span> : null}
                    <span className="text-muted-foreground"> · {actorName(e.actorUserId)}</span>
                  </span>
                  <LocalTime iso={e.createdAt} />
                </li>
              ))}
            </ul>
          )
        ) : movements.ok ? (
          movements.data.length === 0 ? (
            <CardContent>
              <p className="text-sm text-muted-foreground">No stock movements recorded yet.</p>
            </CardContent>
          ) : (
            <ul className="divide-y divide-border">
              {movements.data.map((m) => (
                <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                  <span>
                    {humanize(m.movementType)} · {itemLabel(items.byId.get(m.itemId), m.itemId)} ·{" "}
                    <span className="tabular-nums font-medium">{formatSignedQuantity(m.quantity)}</span>
                    <span className="text-muted-foreground"> · {actorName(m.createdById)}</span>
                  </span>
                  <LocalTime iso={m.occurredAt} />
                </li>
              ))}
            </ul>
          )
        ) : (
          <CardContent>
            <p className="text-sm text-muted-foreground">Activity isn&apos;t available for your role.</p>
          </CardContent>
        )}
      </Card>

      <Notice tone="neutral" title="Not available yet" className="mt-5">
        Sales orders, production stages and quality records aren&apos;t built yet, so this page doesn&apos;t show them. Cost and profitability
        are on each job&apos;s Costs tab for roles that can see cost.
      </Notice>
    </>
  );
}
