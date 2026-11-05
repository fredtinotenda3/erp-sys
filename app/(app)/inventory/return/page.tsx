import { listJobs } from "../../../../src/server/modules/production/job-service";
import { ReturnWorkflow } from "../../../../components/features/inventory/return-workflow";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied, EmptyState, ErrorState } from "../../../../components/ui/states";
import { getPageContext, load } from "../../../../lib/server/page-context";
import { loadItems, loadWarehouses } from "../../../../lib/server/lookups";
import type { Job } from "../../../../lib/api-types";

export const metadata = { title: "Return material from job · Operis" };

export default async function ReturnPage() {
  const ctx = await getPageContext();
  if (!ctx.can("material:issue") || !ctx.can("production_job:read") || !ctx.can("stock:read")) return <AccessDenied what="material returns" />;

  const branchId = ctx.selectedBranchId ?? undefined;
  // A job can still have material returned against it after work is done
  // (in_progress, on_hold, completed, closed all keep material that was
  // issued earlier) -- unlike issuing, returning is not gated on the job
  // still accepting new work, so every non-cancelled status is offered here
  // and the service itself is the authority on what, if anything, is left to
  // return.
  const [jobs, items, warehouses] = await Promise.all([
    load<Job[]>(() => listJobs(ctx.session, { branchId, limit: 500 })),
    loadItems(ctx),
    loadWarehouses(ctx),
  ]);
  if (!jobs.ok || !warehouses.available) return <ErrorState message="The jobs or warehouses couldn't be loaded. Try again in a moment." />;

  const eligible = jobs.data.filter((j) => j.status !== "cancelled" && j.status !== "planned");
  const jobOptions = eligible.map((j) => ({
    id: j.id,
    branchId: j.branchId,
    label: `${j.jobNumber} — ${items.byId.get(j.productItemId)?.name ?? "Product"}${ctx.me.branches.length > 1 ? ` (${ctx.branchName(j.branchId)})` : ""}`,
  }));

  return (
    <>
      <PageHeader
        title="Return material from a job"
        crumbs={[{ label: "Inventory", href: "/inventory/stock" }, { label: "Return from job" }]}
        description="Puts unused or rejected material back into stock. Material issued from a specific lot must say which lot it's going back to."
      />
      {jobOptions.length === 0 ? (
        <EmptyState title="No job has material to return">Only a job that has already had material issued to it can have material returned.</EmptyState>
      ) : (
        <ReturnWorkflow
          jobs={jobOptions}
          warehouses={warehouses.list.filter((w) => w.isActive).map((w) => ({ id: w.id, name: w.name, branchId: w.branchId }))}
          itemNames={Object.fromEntries(items.list.map((i) => [i.id, `${i.name} (${i.sku})`]))}
        />
      )}
    </>
  );
}
