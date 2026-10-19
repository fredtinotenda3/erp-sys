import { listJobs } from "../../../../src/server/modules/production/job-service";
import { IssueWorkflow } from "../../../../components/features/inventory/issue-workflow";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, EmptyState, ErrorState } from "../../../../components/ui/states";
import { getPageContext, load } from "../../../../lib/server/page-context";
import { loadItems, loadWarehouses } from "../../../../lib/server/lookups";
import type { Job } from "../../../../lib/api-types";

export const metadata = { title: "Issue material to job · Operis" };

export default async function IssuePage() {
  const ctx = await getPageContext();
  if (!ctx.can("material:issue") || !ctx.can("production_job:read") || !ctx.can("stock:read")) return <AccessDenied what="material issues" />;

  const branchId = ctx.selectedBranchId ?? undefined;
  const [released, inProgress, items, warehouses] = await Promise.all([
    load<Job[]>(() => listJobs(ctx.session, { branchId, status: "released", limit: 500 })),
    load<Job[]>(() => listJobs(ctx.session, { branchId, status: "in_progress", limit: 500 })),
    loadItems(ctx),
    loadWarehouses(ctx),
  ]);
  if (!released.ok || !inProgress.ok || !warehouses.available) return <ErrorState message="The jobs or warehouses couldn't be loaded. Try again in a moment." />;

  const jobs = [...inProgress.data, ...released.data].map((j) => ({
    id: j.id,
    branchId: j.branchId,
    label: `${j.jobNumber} — ${items.byId.get(j.productItemId)?.name ?? "Product"}${ctx.me.branches.length > 1 ? ` (${ctx.branchName(j.branchId)})` : ""}`,
  }));

  return (
    <>
      <PageHeader title="Issue material to a job" crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Issue to job" }]} description="Takes stock out of a warehouse and charges it to a job. The cost comes from the stock's average cost." />
      {jobs.length === 0 ? (
        <EmptyState title="No job is accepting material">Jobs must be released or in progress before material can be issued to them.</EmptyState>
      ) : (
        <IssueWorkflow
          jobs={jobs}
          warehouses={warehouses.list.filter((w) => w.isActive).map((w) => ({ id: w.id, name: w.name, branchId: w.branchId }))}
          itemNames={Object.fromEntries(items.list.map((i) => [i.id, `${i.name} (${i.sku})`]))}
        />
      )}
    </>
  );
}
