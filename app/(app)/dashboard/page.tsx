import { Suspense, cache } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { listJobs } from "../../../src/server/modules/production/job-service";
import { getShortages } from "../../../src/server/modules/inventory/shortage-service";
import { listAuditLog } from "../../../src/server/modules/iam/audit-service";
import { listStockMovements } from "../../../src/server/modules/inventory/stock-service";
import type { JobStatus } from "../../../src/server/modules/production/job-state";
import { MetricTile } from "../../../components/features/dashboard/metric-tile";
import { PageHeader } from "../../../components/ui/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Notice } from "../../../components/ui/notice";
import { EmptyState, LoadFailure, Skeleton } from "../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/table";
import { JobStatusBadge, OverdueBadge } from "../../../components/ui/status-badge";
import { Quantity } from "../../../components/ui/provenance";
import { LocalTime } from "../../../components/ui/local-time";
import { describeAudit } from "../../../lib/audit-describe";
import { formatDate, humanize, formatSignedQuantity, shortId } from "../../../lib/format";
import { getPageContext, load, type Loaded, type PageContext } from "../../../lib/server/page-context";
import { loadItems, loadUsers, itemLabel, type Lookup } from "../../../lib/server/lookups";
import type { AuditEntry, Job, Shortage, StockMovement, Item, UserLite } from "../../../lib/api-types";

export const metadata = { title: "Command Centre · Operis" };

const LIMIT = 500;
const denied = <T,>(what: string): Loaded<T> => ({ ok: false, status: 403, message: `Your role can't view ${what}.` });

function countText(n: number): string {
  return n >= LIMIT ? `${LIMIT}+` : String(n);
}

// ---------------------------------------------------------------------------
// Per-request-memoized loaders. Several panels below are independent
// Suspense boundaries so one slow query can't hold up the rest of the page,
// but some of them need the SAME underlying data (e.g. "overdue" jobs feed
// both a metric tile and the "requiring attention" card). Wrapping each
// loader in React's cache() means every panel can call it directly -- no
// prop-threading required -- while still issuing exactly one query per
// request: cache() keys on the arguments, and every caller here passes the
// same `ctx` reference (getPageContext() is itself cache()'d, so every
// `await getPageContext()` in this tree resolves to the identical object).
// ---------------------------------------------------------------------------
const jobsByStatus = cache((ctx: PageContext, branchId: string | undefined, status: JobStatus): Promise<Loaded<Job[]>> =>
  ctx.can("production_job:read") ? load<Job[]>(() => listJobs(ctx.session, { branchId, status, limit: LIMIT })) : Promise.resolve(denied<Job[]>("production jobs")),
);

const overdueJobs = cache((ctx: PageContext, branchId: string | undefined): Promise<Loaded<Job[]>> =>
  ctx.can("production_job:read")
    ? load<Job[]>(() => listJobs(ctx.session, { branchId, overdueOnly: true, limit: LIMIT }))
    : Promise.resolve(denied<Job[]>("production jobs")),
);

const shortagesData = cache((ctx: PageContext, branchId: string | undefined): Promise<Loaded<Shortage[]>> =>
  ctx.can("production_job:read") && ctx.can("stock:read") ? load<Shortage[]>(() => getShortages(ctx.session, { branchId })) : Promise.resolve(denied<Shortage[]>("stock")),
);

const itemsLookup = cache((ctx: PageContext): Promise<Lookup<Item>> => loadItems(ctx));
const usersLookup = cache((ctx: PageContext): Promise<Lookup<UserLite>> => loadUsers(ctx));

const auditFeed = cache((ctx: PageContext, branchId: string | undefined): Promise<Loaded<AuditEntry[]>> =>
  ctx.can("audit_log:read")
    ? load<AuditEntry[]>(async () => (await listAuditLog(ctx.session, { branchId, limit: 12 })).map((e) => ({ ...e, id: e.id.toString() })))
    : Promise.resolve(denied<AuditEntry[]>("the audit log")),
);

const movementsFeed = cache((ctx: PageContext): Promise<Loaded<StockMovement[]>> =>
  ctx.can("production_job:read") && ctx.can("stock:read") ? load<StockMovement[]>(() => listStockMovements(ctx.session, { limit: 8 })) : Promise.resolve(denied<StockMovement[]>("stock movements")),
);

// ---------------------------------------------------------------------------
// Loading skeletons -- shapes roughly match what each panel renders, so the
// layout doesn't jump when the real content streams in.
// ---------------------------------------------------------------------------
function TileSkeletons({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </>
  );
}

function CardSkeleton({ title, className }: { title: string; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}

// Command Centre. Every figure here is read from an existing service call; a
// panel the caller can't access, or that fails to load, says so instead of
// showing a number. Orders, stages and quality don't exist yet and are listed
// as unavailable at the bottom rather than faked.
//
// This page itself does no data loading beyond getPageContext() (already
// fast -- see page-context.ts/session-service.ts). Every panel below is its
// own Suspense boundary and async component, so the header and shell render
// immediately and each panel streams in independently: a slow query behind
// one card never blocks the others, or the page shell, from appearing.
export default async function DashboardPage() {
  const ctx = await getPageContext();
  // Operators have no Command Centre; their home is the shop-floor workspace.
  if (ctx.session.role === "PRODUCTION_OPERATOR") redirect("/shop-floor");
  const branchId = ctx.selectedBranchId ?? undefined;
  const scope = ctx.selectedBranchId ? ctx.branchName(ctx.selectedBranchId) : ctx.me.branches.length > 1 ? "all your branches" : ctx.branchName(ctx.me.branches[0]?.id);

  return (
    <>
      <PageHeader title="Command Centre" description={`What is running, what needs attention, and what is short — ${scope}.`} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Suspense fallback={<TileSkeletons count={3} />}>
          <JobMetricTiles ctx={ctx} branchId={branchId} />
        </Suspense>
        <Suspense fallback={<TileSkeletons count={1} />}>
          <ShortageMetricTile ctx={ctx} branchId={branchId} />
        </Suspense>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Suspense fallback={<CardSkeleton title="Jobs requiring attention" />}>
          <AttentionCard ctx={ctx} branchId={branchId} />
        </Suspense>
        <Suspense fallback={<CardSkeleton title="Material shortages" />}>
          <ShortagesCard ctx={ctx} branchId={branchId} />
        </Suspense>
      </div>

      <Suspense fallback={<CardSkeleton title="Active production" className="mt-5" />}>
        <ActiveProductionCard ctx={ctx} branchId={branchId} />
      </Suspense>

      <Suspense fallback={<CardSkeleton title="Recent activity" className="mt-5" />}>
        <ActivityCard ctx={ctx} branchId={branchId} />
      </Suspense>

      <Notice tone="neutral" title="Not available yet" className="mt-5">
        Sales orders, production stages and quality records aren&apos;t built yet, so this page doesn&apos;t show them. Cost and profitability
        are on each job&apos;s Costs tab for roles that can see cost.
      </Notice>
    </>
  );
}

async function JobMetricTiles({ ctx, branchId }: { ctx: PageContext; branchId: string | undefined }) {
  const [inProgress, released, planned, onHold, overdue] = await Promise.all([
    jobsByStatus(ctx, branchId, "in_progress"),
    jobsByStatus(ctx, branchId, "released"),
    jobsByStatus(ctx, branchId, "planned"),
    jobsByStatus(ctx, branchId, "on_hold"),
    overdueJobs(ctx, branchId),
  ]);
  const activeCount = inProgress.ok && released.ok ? inProgress.data.length + released.data.length : null;

  return (
    <>
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
    </>
  );
}

async function ShortageMetricTile({ ctx, branchId }: { ctx: PageContext; branchId: string | undefined }) {
  const shortages = await shortagesData(ctx, branchId);
  const shortageCount = shortages.ok ? shortages.data.filter((s) => s.status === "shortage").length : 0;
  const lowCount = shortages.ok ? shortages.data.filter((s) => s.status === "low").length : 0;

  return shortages.ok ? (
    <MetricTile
      label="Material shortages"
      value={shortageCount}
      detail={lowCount > 0 ? `${lowCount} more below reorder level` : "Open jobs need more than is on hand"}
      href="/inventory/stock"
      tone={shortageCount > 0 ? "danger" : "default"}
    />
  ) : (
    <MetricTile label="Material shortages" unavailableReason={shortages.message} />
  );
}

async function AttentionCard({ ctx, branchId }: { ctx: PageContext; branchId: string | undefined }) {
  const [overdue, onHold, items] = await Promise.all([overdueJobs(ctx, branchId), jobsByStatus(ctx, branchId, "on_hold"), itemsLookup(ctx)]);
  const productName = (id: string) => items.byId.get(id)?.name ?? (items.available ? `Item ${shortId(id)}` : "—");

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

  return (
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
  );
}

async function ShortagesCard({ ctx, branchId }: { ctx: PageContext; branchId: string | undefined }) {
  const [shortages, items] = await Promise.all([shortagesData(ctx, branchId), itemsLookup(ctx)]);
  const shortageRows = shortages.ok ? shortages.data.filter((s) => s.status === "shortage") : [];

  return (
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
  );
}

async function ActiveProductionCard({ ctx, branchId }: { ctx: PageContext; branchId: string | undefined }) {
  const [inProgress, released, overdue, items] = await Promise.all([
    jobsByStatus(ctx, branchId, "in_progress"),
    jobsByStatus(ctx, branchId, "released"),
    overdueJobs(ctx, branchId),
    itemsLookup(ctx),
  ]);
  const productName = (id: string) => items.byId.get(id)?.name ?? (items.available ? `Item ${shortId(id)}` : "—");
  const overdueIds = new Set(overdue.ok ? overdue.data.map((j) => j.id) : []);
  const activeRows = inProgress.ok && released.ok ? [...inProgress.data, ...released.data].slice(0, 8) : [];

  return (
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
  );
}

async function ActivityCard({ ctx, branchId }: { ctx: PageContext; branchId: string | undefined }) {
  const [audit, movements, items, users] = await Promise.all([auditFeed(ctx, branchId), movementsFeed(ctx), itemsLookup(ctx), usersLookup(ctx)]);
  const actorName = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "System");

  return (
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
  );
}
