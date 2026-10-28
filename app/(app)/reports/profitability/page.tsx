import Link from "next/link";
import { Download } from "lucide-react";

import { getProfitabilityReport } from "../../../../src/server/modules/costing/cost-service";
import { PrintButton } from "../../../../components/features/shared/print-button";
import { Pagination } from "../../../../components/features/shared/pagination";
import { SortableTH } from "../../../../components/features/shared/sortable-th";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { buttonVariants } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Input } from "../../../../components/ui/input";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Money, Unavailable } from "../../../../components/ui/provenance";
import { Select } from "../../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { formatDate, humanize } from "../../../../lib/format";
import { isUuid } from "../../../../lib/validate";
import { getPageContext, load, param } from "../../../../lib/server/page-context";
import { loadCustomers, loadItems } from "../../../../lib/server/lookups";

export const metadata = { title: "Profitability report · Operis" };
const PAGE_SIZE = 25;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SORTS = ["job", "completed", "profit", "margin"] as const;

type Profit =
  | { available: true; currency: string; revenue: string; actualCost: string; grossProfit: string; marginPercent: string | null; labourRecorded: boolean }
  | { available: false; reason: string };
interface Row { jobId: string; jobNumber: string; completedAt: string | null; product: { id: string; sku: string; name: string }; customer?: { id: string; name: string } | null; adjusted: boolean; missing: string[]; profit: Profit }
interface Report { rows: Row[]; totalsByCurrency: { currency: string; jobs: number; revenue: string; actualCost: string; grossProfit: string; marginPercent: string | null }[]; excludedJobs: number }

// Why a job has no profit figure, in plain words. The backend decides; this only explains.
const REASONS: Record<string, string> = {
  no_revenue: "no quote on the job",
  mixed_currencies: "costs are in a different currency than the quote",
  no_actual_cost: "no cost recorded",
};
const why = (r: string) => REASONS[r] ?? humanize(r);
const n = (v: string | null | undefined) => (v === null || v === undefined ? Number.NEGATIVE_INFINITY : Number(v));

export default async function ProfitabilityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("cost:read") || !ctx.can("production_job:read")) return <AccessDenied what="the profitability report" />;

  const sp = await searchParams;
  const fromS = param(sp.from);
  const toS = param(sp.to);
  const from = fromS && DATE.test(fromS) ? fromS : undefined;
  const to = toS && DATE.test(toS) ? toS : undefined;
  const c = param(sp.customerId);
  const customerId = c && isUuid(c) ? c : undefined;
  const pr = param(sp.productItemId);
  const productItemId = pr && isUuid(pr) ? pr : undefined;
  const sortP = param(sp.sort);
  const sort = (SORTS as readonly string[]).includes(sortP ?? "") ? (sortP as (typeof SORTS)[number]) : "completed";
  const dir = param(sp.dir) === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);
  const branchId = ctx.selectedBranchId ?? undefined;

  const [res, customers, items] = await Promise.all([
    load<Report>(() => getProfitabilityReport(ctx.session, { from: from ? `${from}T00:00:00Z` : undefined, to: to ? `${to}T23:59:59.999Z` : undefined, branchId, customerId, productItemId })),
    ctx.can("customer:read") ? loadCustomers(ctx) : Promise.resolve(null),
    ctx.can("item:read") ? loadItems(ctx, {}) : Promise.resolve(null),
  ]);

  const rows = res.ok ? [...res.data.rows] : [];
  rows.sort((a, b) => {
    const m = dir === "asc" ? 1 : -1;
    if (sort === "job") return a.jobNumber.localeCompare(b.jobNumber, undefined, { numeric: true }) * m;
    if (sort === "profit") return (n(a.profit.available ? a.profit.grossProfit : null) - n(b.profit.available ? b.profit.grossProfit : null)) * m || 0;
    if (sort === "margin") return (n(a.profit.available ? a.profit.marginPercent : null) - n(b.profit.available ? b.profit.marginPercent : null)) * m || 0;
    return ((a.completedAt ?? "").localeCompare(b.completedAt ?? "")) * m;
  });
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const keep = { from, to, customerId, productItemId };
  const exportQ = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...keep, branchId })) if (v) exportQ.set(k, v);
  const filtered = Boolean(from || to || customerId || productItemId);

  return (
    <>
      <PageHeader
        title="Profitability"
        crumbs={[{ label: "Reports", href: "/reports" }, { label: "Profitability" }]}
        description={`${branchId ? ctx.branchName(branchId) : "All your branches"} · completed jobs only.`}
        actions={<><PrintButton /><Link href={`/api/v1/reports/profitability/export?${exportQ.toString()}`} className={buttonVariants({ variant: "outline" })} data-print-hide><Download /> Export CSV</Link></>}
      />
      <Notice tone="info" className="mb-4">
        The &ldquo;quoted amount&rdquo; is what the job was quoted, not recognised revenue — nothing here is invoiced or booked. Profit is <strong>gross profit before overhead</strong>: quote minus recorded material and labour cost. Figures are never converted between currencies.
      </Notice>
      <FilterBar resetHref="/reports/profitability">
        <FilterField id="from" label="Completed from"><Input id="from" name="from" type="date" defaultValue={from ?? ""} /></FilterField>
        <FilterField id="to" label="Completed to"><Input id="to" name="to" type="date" defaultValue={to ?? ""} /></FilterField>
        {customers?.available ? (
          <FilterField id="customerId" label="Customer"><Select id="customerId" name="customerId" defaultValue={customerId ?? ""}><option value="">All customers</option>{customers.list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></FilterField>
        ) : null}
        {items?.available ? (
          <FilterField id="productItemId" label="Product"><Select id="productItemId" name="productItemId" defaultValue={productItemId ?? ""}><option value="">All products</option>{items.list.filter((i) => i.itemType === "finished_good" || i.itemType === "wip").map((i) => <option key={i.id} value={i.id}>{i.name} ({i.sku})</option>)}</Select></FilterField>
        ) : null}
      </FilterBar>

      {!res.ok ? <LoadFailure status={res.status} message={res.message} what="the profitability report" /> : rows.length === 0 ? (
        <EmptyState title={filtered ? "No completed jobs match these filters" : "No completed jobs yet"}>{filtered ? "Widen the dates or clear a filter." : "Profitability appears after a job is completed and its cost is frozen."}</EmptyState>
      ) : (
        <>
          {res.data.totalsByCurrency.length > 0 ? (
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {res.data.totalsByCurrency.map((t) => (
                <Card key={t.currency} className="space-y-1 p-4">
                  <h2 className="text-xs font-medium text-muted-foreground">{t.currency} · {t.jobs} job{t.jobs === 1 ? "" : "s"} with a profit figure</h2>
                  <p className="text-xl font-semibold"><Money amount={t.grossProfit} currency={t.currency} /></p>
                  <p className="text-xs text-muted-foreground">Quoted <Money amount={t.revenue} currency={t.currency} /> − cost <Money amount={t.actualCost} currency={t.currency} />{t.marginPercent !== null ? ` · margin ${t.marginPercent}%` : ""}</p>
                </Card>
              ))}
            </div>
          ) : null}
          {res.data.excludedJobs > 0 ? <Notice tone="warning" className="mb-4">{res.data.excludedJobs} job{res.data.excludedJobs === 1 ? " is" : "s are"} left out of the totals because profit can&apos;t be stated reliably (reason shown on each row).</Notice> : null}
          <Card>
            <Table>
              <THead>
                <tr>
                  <SortableTH label="Job" sortKey="job" basePath="/reports/profitability" params={keep} sort={sort} dir={dir} />
                  <SortableTH label="Completed" sortKey="completed" basePath="/reports/profitability" params={keep} sort={sort} dir={dir} />
                  <TH>Product</TH>
                  {customers?.available ? <TH>Customer</TH> : null}
                  <TH className="text-right">Quoted amount</TH>
                  <TH className="text-right">Actual cost</TH>
                  <SortableTH label="Gross profit" sortKey="profit" basePath="/reports/profitability" params={keep} sort={sort} dir={dir} className="text-right" />
                  <SortableTH label="Margin" sortKey="margin" basePath="/reports/profitability" params={keep} sort={sort} dir={dir} className="text-right" />
                </tr>
              </THead>
              <TBody>
                {slice.map((r) => (
                  <TR key={r.jobId}>
                    <TD><Link href={`/production/jobs/${r.jobId}`} className="font-medium text-primary underline-offset-2 hover:underline">{r.jobNumber}</Link>{r.adjusted ? <span className="block text-xs text-muted-foreground">cost corrected</span> : null}</TD>
                    <TD>{formatDate(r.completedAt)}</TD>
                    <TD>{r.product.name}<span className="block text-xs text-muted-foreground">{r.product.sku}</span></TD>
                    {customers?.available ? <TD>{r.customer?.name ?? "—"}</TD> : null}
                    {r.profit.available ? (
                      <>
                        <TD className="text-right"><Money amount={r.profit.revenue} currency={r.profit.currency} /></TD>
                        <TD className="text-right"><Money amount={r.profit.actualCost} currency={r.profit.currency} /></TD>
                        <TD className="text-right"><Money amount={r.profit.grossProfit} currency={r.profit.currency} /></TD>
                        <TD className="text-right">{r.profit.marginPercent !== null ? `${r.profit.marginPercent}%` : "—"}</TD>
                      </>
                    ) : <TD colSpan={4}><Unavailable reason={why(r.profit.reason)} /></TD>}
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination basePath="/reports/profitability" params={{ ...keep, sort, dir }} page={page} pageSize={PAGE_SIZE} total={rows.length} />
          </Card>
        </>
      )}
    </>
  );
}
